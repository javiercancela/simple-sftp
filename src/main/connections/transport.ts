// Application-owned transport adapter over @electerm/ssh2.
// Exposes only: connect/disconnect, host verification, list/stat/realpath and
// read streams. No remote write, delete, rename, shell or exec (spec 9.4).
import { Client, type ConnectConfig, type SFTPWrapper, type SftpAttrs } from '@electerm/ssh2';
import type { Readable } from 'node:stream';
import type {
  HostKeyInfo,
  RemoteEntry,
  RemoteEntryType,
  RemoteStat,
} from '../../shared/transport-contract';
import type { LoadedCredentials } from './credentials';
import { TransportError, isTransportError } from './errors';
import { describeHostKey } from './host-key';

/**
 * Decide whether to trust a presented host key. Resolve true to continue,
 * false to cancel, or throw a TransportError (e.g. HOST_KEY_MISMATCH).
 * Called before any user authentication is sent.
 */
export type HostVerifier = (info: HostKeyInfo) => Promise<boolean>;

export interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  credentials: LoadedCredentials;
  verifyHost: HostVerifier;
  /** Excludes time spent awaiting verifyHost. Default 20 s. */
  timeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  signal?: AbortSignal;
  /** Protocol-level debug lines (no key material). For tests/diagnostics. */
  debug?: (line: string) => void;
}

export interface SftpSession {
  readonly hostKey: HostKeyInfo;
  list(path: string): Promise<RemoteEntry[]>;
  stat(path: string): Promise<RemoteStat>;
  lstat(path: string): Promise<RemoteStat>;
  realpath(path: string): Promise<string>;
  /** Backpressure-aware stream of a remote file. */
  createReadStream(path: string, options?: { start?: number }): Readable;
  disconnect(): Promise<void>;
  /** Fires once when the transport closes for any reason. */
  onClose(listener: (error: TransportError | undefined) => void): () => void;
}

/** Host-key algorithms offered; excludes SHA-1 ssh-rsa and host certificates. */
const HOST_KEY_ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
];

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function entryType(attrs: SftpAttrs): RemoteEntryType {
  if (attrs.mode === undefined) return 'other';
  switch (attrs.mode & S_IFMT) {
    case S_IFDIR:
      return 'directory';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'symlink';
    default:
      return 'other';
  }
}

function toStat(attrs: SftpAttrs): RemoteStat {
  return {
    type: entryType(attrs),
    size: typeof attrs.size === 'number' ? attrs.size : null,
    modifiedTime: typeof attrs.mtime === 'number' ? attrs.mtime : null,
  };
}

function sftpError(err: Error & { code?: number }, path: string): TransportError {
  // SSH_FX_NO_SUCH_FILE = 2, SSH_FX_PERMISSION_DENIED = 3
  if (err.code === 2)
    return new TransportError('REMOTE_NOT_FOUND', 'The remote path does not exist.', path);
  if (err.code === 3)
    return new TransportError('REMOTE_PERMISSION_DENIED', 'Permission denied on the server.', path);
  return new TransportError(
    'REMOTE_ERROR',
    'The server returned an error.',
    `${path}: ${err.message}`,
  );
}

function classifyClientError(err: Error & { level?: string; code?: string }): TransportError {
  const level = err.level ?? '';
  if (level === 'client-timeout')
    return new TransportError('TIMEOUT', 'The server did not respond in time.');
  if (level === 'client-authentication') {
    return new TransportError(
      'AUTH_REJECTED',
      'The server rejected the key or certificate. Check the username, certificate principals and CA trust.',
      err.message,
    );
  }
  if (level === 'client-socket' || typeof err.code === 'string') {
    return new TransportError('NETWORK', 'Could not reach the server.', err.code ?? err.message);
  }
  return new TransportError('NETWORK', 'The connection failed.', err.message);
}

class Session implements SftpSession {
  private closed = false;
  private closeError: TransportError | undefined;
  private readonly listeners = new Set<(e: TransportError | undefined) => void>();

  constructor(
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
    readonly hostKey: HostKeyInfo,
  ) {
    client.on('error', (err: Error & { level?: string }) => {
      this.closeError = classifyClientError(err);
    });
    client.on('close', () => this.markClosed());
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.listeners) l(this.closeError);
    this.listeners.clear();
  }

  private ensureOpen(): void {
    if (this.closed) throw new TransportError('DISCONNECTED', 'Not connected.');
  }

  list(path: string): Promise<RemoteEntry[]> {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      this.sftp.readdir(path, (err, list) => {
        if (err) return reject(sftpError(err, path));
        resolve(
          list
            .filter((e) => e.filename !== '.' && e.filename !== '..')
            .map((e) => ({ name: e.filename, ...toStat(e.attrs) })),
        );
      });
    });
  }

  stat(path: string): Promise<RemoteStat> {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      this.sftp.stat(path, (err, attrs) =>
        err ? reject(sftpError(err, path)) : resolve(toStat(attrs)),
      );
    });
  }

  lstat(path: string): Promise<RemoteStat> {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      this.sftp.lstat(path, (err, attrs) =>
        err ? reject(sftpError(err, path)) : resolve(toStat(attrs)),
      );
    });
  }

  realpath(path: string): Promise<string> {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      this.sftp.realpath(path, (err, abs) => (err ? reject(sftpError(err, path)) : resolve(abs)));
    });
  }

  createReadStream(path: string, options: { start?: number } = {}): Readable {
    this.ensureOpen();
    return this.sftp.createReadStream(path, {
      start: options.start ?? 0,
      highWaterMark: 64 * 1024,
    });
  }

  disconnect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.onClose(() => resolve());
      try {
        this.sftp.end();
      } catch {
        /* ignore */
      }
      this.client.end();
      // Hard stop if the server does not close promptly.
      setTimeout(() => {
        if (!this.closed) this.client.destroy();
      }, 3000).unref();
    });
  }

  onClose(listener: (e: TransportError | undefined) => void): () => void {
    if (this.closed) {
      queueMicrotask(() => listener(this.closeError));
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function connect(opts: ConnectOptions): Promise<SftpSession> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const client = new Client();

  return new Promise<SftpSession>((resolve, reject) => {
    let settled = false;
    let hostKey: HostKeyInfo | undefined;
    let hostFailure: TransportError | undefined;

    // Connection timer that pauses while awaiting the user's trust decision.
    let remaining = timeoutMs;
    let timerStarted = 0;
    let timer: NodeJS.Timeout | undefined;
    const startTimer = (): void => {
      timerStarted = Date.now();
      timer = setTimeout(
        () => fail(new TransportError('TIMEOUT', 'The server did not respond in time.')),
        remaining,
      );
    };
    const pauseTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      remaining = Math.max(0, remaining - (Date.now() - timerStarted));
    };

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: TransportError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      client.destroy();
      reject(err);
    };
    const onAbort = (): void => fail(new TransportError('CANCELLED', 'Connection cancelled.'));
    if (opts.signal?.aborted) {
      reject(new TransportError('CANCELLED', 'Connection cancelled.'));
      return;
    }
    opts.signal?.addEventListener('abort', onAbort);

    const config: ConnectConfig = {
      host: opts.host,
      port: opts.port,
      username: opts.username,
      privateKey: opts.credentials.keyData,
      // Only publickey; never password, keyboard-interactive or agent.
      authHandler: ['publickey'],
      tryKeyboard: false,
      agent: undefined,
      readyTimeout: 0, // replaced by our pausable timer
      keepaliveInterval: opts.keepaliveIntervalMs ?? 30_000,
      keepaliveCountMax: opts.keepaliveCountMax ?? 3,
      algorithms: { serverHostKey: HOST_KEY_ALGORITHMS },
      hostVerifier: (keyBlob, verify) => {
        const info = describeHostKey(opts.host, opts.port, keyBlob);
        hostKey = info;
        if (info.algorithm.endsWith('-cert-v01@openssh.com')) {
          hostFailure = new TransportError(
            'HOST_KEY_UNSUPPORTED',
            'Host certificates are not supported.',
          );
          verify(false);
          return undefined;
        }
        pauseTimer();
        opts.verifyHost(info).then(
          (ok) => {
            if (settled) return verify(false);
            if (!ok)
              hostFailure = new TransportError('HOST_KEY_REJECTED', 'Host key was not trusted.');
            else startTimer();
            verify(ok);
          },
          (err: unknown) => {
            hostFailure = isTransportError(err)
              ? err
              : new TransportError('HOST_KEY_REJECTED', 'Host verification failed.');
            verify(false);
          },
        );
        return undefined;
      },
    };
    if (opts.credentials.passphrase !== undefined) config.passphrase = opts.credentials.passphrase;
    if (opts.credentials.certificate) config.certificate = opts.credentials.certificate.blob;
    if (opts.debug) config.debug = opts.debug;

    client.on('error', (err: Error & { level?: string }) => {
      if (hostFailure) return fail(hostFailure);
      fail(classifyClientError(err));
    });
    client.on('close', () => {
      if (hostFailure) return fail(hostFailure);
      fail(new TransportError('NETWORK', 'The connection closed before it was ready.'));
    });
    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err || !hostKey) {
          return fail(
            new TransportError('SFTP_UNAVAILABLE', 'The server does not offer SFTP.', err?.message),
          );
        }
        if (settled) {
          client.end();
          return;
        }
        settled = true;
        cleanup();
        resolve(new Session(client, sftp, hostKey));
      });
    });

    startTimer();
    try {
      client.connect(config);
      // Without TCP_NODELAY, sequential SFTP reads stall on Nagle/delayed-ACK
      // (~40 ms per request): measured 1.4 MiB/s vs ~160 MiB/s on localhost.
      client.setNoDelay(true);
    } catch (err) {
      fail(
        new TransportError(
          'CREDENTIAL_UNSUPPORTED',
          'The credentials could not be used.',
          (err as Error).message,
        ),
      );
    }
  });
}
