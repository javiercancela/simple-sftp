// Connection lifecycle (spec 5.1/5.2). Owns the single active connection,
// the outstanding trust/passphrase challenge and the state snapshot sent to
// the renderer. Electron-free: dependencies are injected.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  transition,
  type Challenge,
  type ConnectionError,
  type ConnectionEvent,
  type ConnectionSnapshot,
} from '../../shared/connection';
import type { Profile } from '../../shared/profiles';
import type { HostKeyInfo } from '../../shared/transport-contract';
import { loadCredentials, type LoadedCredentials } from './credentials';
import { TransportError, isTransportError } from './errors';
import { connect as transportConnect, type SftpSession } from './transport';
import type { TrustStore } from './trust-store';

export class StaleRequestError extends Error {
  constructor(what: string) {
    super(`${what} is no longer current`);
  }
}

export interface ConnectionManagerDeps {
  getProfile(id: string): Profile | undefined;
  trust: TrustStore;
  emit(snapshot: ConnectionSnapshot): void;
  timeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  /** Test hook: protocol debug lines. */
  debug?: (line: string) => void;
}

type PendingReply =
  | {
      kind: 'hostTrust';
      challengeId: string;
      resolve: (accept: boolean) => void;
      reject: (e: Error) => void;
    }
  | {
      kind: 'passphrase';
      challengeId: string;
      resolve: (pass: string) => void;
      reject: (e: Error) => void;
    };

interface Attempt {
  sessionId: string;
  abort: AbortController;
  done: Promise<void>;
}

const CANCELLED = (): TransportError => new TransportError('CANCELLED', 'Connection cancelled.');

export class ConnectionManager {
  private snap: ConnectionSnapshot = {
    revision: 0,
    sessionId: null,
    profileId: null,
    profileName: null,
    state: 'disconnected',
    challenge: null,
    error: null,
    hostKey: null,
    remoteHome: null,
  };
  private attempt: Attempt | null = null;
  private session: SftpSession | null = null;
  private pending: PendingReply | null = null;

  constructor(private readonly deps: ConnectionManagerDeps) {}

  getSnapshot(): ConnectionSnapshot {
    return structuredClone(this.snap);
  }

  /** The live SFTP session (used by browsing in the next milestone). */
  getSession(sessionId: string): SftpSession | null {
    return this.snap.sessionId === sessionId && this.snap.state === 'connected'
      ? this.session
      : null;
  }

  private update(ev: ConnectionEvent['type'] | null, patch: Partial<ConnectionSnapshot>): void {
    let state = this.snap.state;
    if (ev) {
      const next = transition(state, ev);
      if (next === null) throw new Error(`invalid transition ${state} --${ev}-->`);
      state = next;
    }
    this.snap = { ...this.snap, ...patch, state, revision: this.snap.revision + 1 };
    this.deps.emit(this.getSnapshot());
  }

  /** Start connecting; resolves with the new session id once started. */
  async connect(profileId: string): Promise<string> {
    const profile = this.deps.getProfile(profileId);
    if (!profile) throw new TransportError('CANCELLED', 'Profile not found.');
    // One active connection: close or cancel whatever exists first.
    await this.stopCurrent();
    const sessionId = randomUUID();
    const abort = new AbortController();
    this.update('CONNECT', {
      sessionId,
      profileId: profile.id,
      profileName: profile.name,
      challenge: null,
      error: null,
      hostKey: null,
      remoteHome: null,
    });
    const attempt: Attempt = { sessionId, abort, done: Promise.resolve() };
    attempt.done = this.run(attempt, profile).catch(() => undefined);
    this.attempt = attempt;
    return sessionId;
  }

  private async stopCurrent(): Promise<void> {
    if (this.attempt && this.snap.sessionId === this.attempt.sessionId && this.isConnecting()) {
      const a = this.attempt;
      this.cancelInternal();
      await a.done;
    }
    if (this.session && this.snap.state === 'connected' && this.snap.sessionId) {
      await this.disconnect(this.snap.sessionId);
    }
  }

  private isConnecting(): boolean {
    return ['connecting', 'awaitingHostTrust', 'awaitingPassphrase'].includes(this.snap.state);
  }

  private ask<T extends PendingReply['kind']>(
    challenge: Challenge & { kind: T },
    signal: AbortSignal,
  ): Promise<T extends 'hostTrust' ? boolean : string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(CANCELLED());
      const onAbort = (): void => {
        if (this.pending?.challengeId === challenge.challengeId) this.pending = null;
        reject(CANCELLED());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const done =
        <V>(fn: (v: V) => void) =>
        (v: V) => {
          signal.removeEventListener('abort', onAbort);
          this.pending = null;
          fn(v);
        };
      this.pending = {
        kind: challenge.kind,
        challengeId: challenge.challengeId,
        resolve: done(resolve as (v: unknown) => void),
        reject: done(reject),
      } as PendingReply;
    });
  }

  private async loadWithPassphrase(
    profile: Profile,
    signal: AbortSignal,
  ): Promise<LoadedCredentials> {
    let passphrase: string | undefined;
    for (;;) {
      try {
        const creds = await loadCredentials({
          privateKeyPath: profile.privateKeyPath,
          ...(profile.authMode === 'privateKeyAndCertificate' && profile.certificatePath
            ? { certificatePath: profile.certificatePath }
            : {}),
          ...(passphrase !== undefined ? { passphrase } : {}),
        });
        return creds;
      } catch (err) {
        if (signal.aborted) throw CANCELLED();
        if (
          !isTransportError(err) ||
          (err.code !== 'PASSPHRASE_REQUIRED' && err.code !== 'PASSPHRASE_INCORRECT')
        ) {
          throw err;
        }
        const challenge = {
          kind: 'passphrase' as const,
          challengeId: randomUUID(),
          keyFileName: path.basename(profile.privateKeyPath),
          retry: err.code === 'PASSPHRASE_INCORRECT',
        };
        this.update('NEED_PASSPHRASE', { challenge });
        passphrase = await this.ask(challenge, signal);
        this.update('PASSPHRASE_SUBMITTED', { challenge: null });
      }
    }
  }

  private async run(attempt: Attempt, profile: Profile): Promise<void> {
    const { signal } = attempt.abort;
    const current = (): boolean => this.snap.sessionId === attempt.sessionId && !signal.aborted;
    let mismatch: { expected: string; received: string } | null = null;
    try {
      let creds: LoadedCredentials | null = await this.loadWithPassphrase(profile, signal);
      if (!current()) throw CANCELLED();
      const session = await transportConnect({
        host: profile.host,
        port: profile.port,
        username: profile.username,
        credentials: creds,
        signal,
        ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
        keepaliveIntervalMs: this.deps.keepaliveIntervalMs ?? 30_000,
        keepaliveCountMax: this.deps.keepaliveCountMax ?? 3,
        ...(this.deps.debug ? { debug: this.deps.debug } : {}),
        verifyHost: async (info: HostKeyInfo) => {
          if (!current()) return false;
          this.snap = { ...this.snap, hostKey: info };
          const ev = this.deps.trust.evaluate(info);
          if (ev.kind === 'trusted') return true;
          if (ev.kind === 'mismatch') {
            mismatch = {
              expected: ev.expected.fingerprintSha256,
              received: info.fingerprintSha256,
            };
            throw new TransportError(
              'HOST_KEY_MISMATCH',
              'The server presented a different host key than the one you trusted. The connection was blocked.',
              `expected ${mismatch.expected} (${ev.expected.algorithm}), received ${mismatch.received} (${info.algorithm})`,
            );
          }
          const challenge = {
            kind: 'hostTrust' as const,
            challengeId: randomUUID(),
            hostKey: info,
          };
          this.update('HOST_KEY_UNKNOWN', { challenge, hostKey: info });
          const accepted = await this.ask(challenge, signal);
          if (!accepted || !current()) return false;
          await this.deps.trust.trust(info); // persisted only after explicit acceptance
          this.update('HOST_TRUSTED', { challenge: null });
          return true;
        },
      });
      creds = null; // drop key material and passphrase references
      if (!current()) {
        await session.disconnect();
        return;
      }
      let remoteHome: string | null = null;
      try {
        remoteHome = await session.realpath('.');
      } catch {
        remoteHome = null;
      }
      if (!current()) {
        await session.disconnect();
        return;
      }
      this.session = session;
      session.onClose((err) => {
        if (this.session !== session) return;
        this.session = null;
        if (this.snap.state === 'connected' || this.snap.state === 'disconnecting') {
          const lost = this.snap.state === 'connected';
          this.update('CLOSED', {
            challenge: null,
            remoteHome: null,
            error: lost && err ? toConnectionError(err, null) : null,
          });
        }
      });
      this.update('READY', { remoteHome });
    } catch (err) {
      if (this.snap.sessionId !== attempt.sessionId) return; // superseded
      const te = isTransportError(err)
        ? err
        : new TransportError('NETWORK', 'Connection failed.', (err as Error).message);
      if (signal.aborted || te.code === 'CANCELLED' || te.code === 'HOST_KEY_REJECTED') {
        // User cancelled (incl. Cancel on the trust dialog): back to disconnected.
        if (this.isConnecting()) this.update('CANCEL', { challenge: null });
        return;
      }
      if (this.isConnecting())
        this.update('FAIL', { challenge: null, error: toConnectionError(te, mismatch) });
    } finally {
      if (this.attempt === attempt) this.attempt = null;
    }
  }

  private cancelInternal(): void {
    const a = this.attempt;
    if (!a) return;
    a.abort.abort();
    this.pending?.reject(CANCELLED());
    this.pending = null;
  }

  cancel(sessionId: string): void {
    if (this.snap.sessionId !== sessionId || !this.isConnecting())
      throw new StaleRequestError('Session');
    this.cancelInternal();
    if (this.isConnecting()) this.update('CANCEL', { challenge: null });
  }

  async disconnect(sessionId: string): Promise<void> {
    if (this.snap.sessionId !== sessionId) throw new StaleRequestError('Session');
    if (this.isConnecting()) {
      this.cancel(sessionId);
      return;
    }
    if (this.snap.state !== 'connected' || !this.session) throw new StaleRequestError('Session');
    const session = this.session;
    this.update('DISCONNECT', {});
    await session.disconnect();
    // onClose moves to disconnected; make sure even if it already fired.
    if ((this.snap.state as string) === 'disconnecting') {
      this.session = null;
      this.update('CLOSED', { remoteHome: null });
    }
  }

  private takePending(kind: PendingReply['kind'], challengeId: string): PendingReply {
    const p = this.pending;
    if (!p || p.kind !== kind || p.challengeId !== challengeId)
      throw new StaleRequestError('Challenge');
    return p;
  }

  acceptTrust(challengeId: string): void {
    const p = this.takePending('hostTrust', challengeId);
    if (p.kind === 'hostTrust') p.resolve(true);
  }

  rejectTrust(challengeId: string): void {
    const p = this.takePending('hostTrust', challengeId);
    if (p.kind === 'hostTrust') p.resolve(false);
  }

  submitPassphrase(challengeId: string, passphrase: string): void {
    const p = this.takePending('passphrase', challengeId);
    if (p.kind === 'passphrase') p.resolve(passphrase);
  }

  cancelPassphrase(challengeId: string): void {
    this.takePending('passphrase', challengeId);
    if (this.snap.sessionId) this.cancel(this.snap.sessionId);
  }

  /** Close everything (app quit). */
  async shutdown(): Promise<void> {
    this.cancelInternal();
    const s = this.session;
    this.session = null;
    if (s) await s.disconnect();
  }
}

function toConnectionError(
  err: TransportError,
  mismatch: { expected: string; received: string } | null,
): ConnectionError {
  return {
    code: err.code,
    message: err.message,
    ...(err.detail ? { detail: err.detail } : {}),
    ...(mismatch
      ? { expectedFingerprint: mismatch.expected, receivedFingerprint: mismatch.received }
      : {}),
  };
}
