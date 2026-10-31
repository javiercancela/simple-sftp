// Real OpenSSH server fixture. Runs sshd unprivileged, bound to 127.0.0.1
// only, with throwaway keys generated under tests/.tmp (gitignored).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';

export interface SshdBinary {
  sshd: string;
  libexecDir: string | undefined;
  env: NodeJS.ProcessEnv;
}

/**
 * Locate sshd. Order: $SFTP_TEST_SSHD, /usr/sbin/sshd.
 * $SFTP_TEST_SSHD_LD_LIBRARY_PATH is added to the child environment when set
 * (for an sshd extracted from a .deb rather than installed).
 */
export function findSshd(): SshdBinary | undefined {
  const repoTools = resolve(__dirname, '..', '..', '..', '.tools', 'openssh', 'root');
  const candidates = [
    process.env.SFTP_TEST_SSHD,
    '/usr/sbin/sshd',
    '/usr/local/sbin/sshd',
    join(repoTools, 'usr', 'sbin', 'sshd'), // scripts/fetch-test-sshd-debian.sh
  ];
  const sshd = candidates.find((c): c is string => !!c && existsSync(c));
  if (!sshd) return undefined;
  const libexecCandidates = [
    process.env.SFTP_TEST_SSHD_LIBEXEC,
    join(dirname(sshd), '..', 'lib', 'openssh'),
    join(dirname(sshd), '..', 'libexec'),
  ];
  const libexecDir = libexecCandidates.find(
    (c): c is string => !!c && existsSync(join(c, 'sshd-session')),
  );
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (process.env.SFTP_TEST_SSHD_LD_LIBRARY_PATH) {
    env.LD_LIBRARY_PATH = process.env.SFTP_TEST_SSHD_LD_LIBRARY_PATH;
  } else if (sshd.startsWith(repoTools)) {
    env.LD_LIBRARY_PATH = join(repoTools, 'usr', 'lib', 'x86_64-linux-gnu');
  }
  return { sshd: resolve(sshd), libexecDir: libexecDir && resolve(libexecDir), env };
}

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

export interface SshdConfig {
  dir: string; // working directory for this server instance
  port: number;
  hostKeys: string[]; // private host key paths
  sftpRoot: string;
  /** Plain-key mode: authorized public keys (file contents lines). */
  authorizedKeys?: string[];
  /** Certificate mode: CA public key line and accepted principals. */
  trustedUserCa?: string;
  principals?: string[];
  pubkeyAcceptedAlgorithms?: string;
  /** Default 'no' (tests fail auth on purpose); set to exercise penalties. */
  perSourcePenalties?: string;
  /** Default DEBUG3. Use INFO for large transfers. */
  logLevel?: string;
  /**
   * 'internal' (default): internal-sftp inside sshd-session.
   * 'external': a separate sftp-server process, which tests can kill to make
   * the SFTP subsystem disappear while SSH stays connected.
   * 'none': no SFTP subsystem at all (SSH logins work, SFTP is refused).
   */
  sftpServer?: 'internal' | 'external' | 'none';
}

export class SshdInstance {
  private proc: ChildProcess | undefined;
  private logBuf = '';
  constructor(
    readonly bin: SshdBinary,
    readonly cfg: SshdConfig,
  ) {}

  get log(): string {
    return this.logBuf;
  }

  clearLog(): void {
    this.logBuf = '';
  }

  async start(): Promise<void> {
    const c = this.cfg;
    await mkdir(c.dir, { recursive: true });
    const lines = [
      'ListenAddress 127.0.0.1',
      `Port ${c.port}`,
      ...c.hostKeys.map((k) => `HostKey ${k}`),
      `PidFile ${join(c.dir, 'sshd.pid')}`,
      'UsePAM no',
      'StrictModes no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes',
      'AuthenticationMethods publickey',
      'AllowTcpForwarding no',
      'AllowAgentForwarding no',
      'X11Forwarding no',
      'PermitTTY no',
      `LogLevel ${c.logLevel ?? 'DEBUG3'}`,
      // OpenSSH >= 9.8 penalizes sources after failed auths; tests fail on purpose.
      `PerSourcePenalties ${c.perSourcePenalties ?? 'no'}`,
    ];
    if (c.sftpServer !== 'none') lines.push('Subsystem sftp internal-sftp');
    if (c.sftpServer === 'none') {
      // No subsystem and no forced command: the sftp request is refused.
    } else if (c.sftpServer === 'external') {
      const server = this.bin.libexecDir && join(this.bin.libexecDir, 'sftp-server');
      if (!server || !existsSync(server)) throw new Error('sftp-server binary not found');
      const ld = this.bin.env.LD_LIBRARY_PATH
        ? `env LD_LIBRARY_PATH=${this.bin.env.LD_LIBRARY_PATH} `
        : '';
      lines.push(`ForceCommand ${ld}${server} -d ${c.sftpRoot}`);
    } else {
      lines.push(`ForceCommand internal-sftp -d ${c.sftpRoot}`);
    }
    if (this.bin.libexecDir) {
      lines.push(`SshdSessionPath ${join(this.bin.libexecDir, 'sshd-session')}`);
      if (existsSync(join(this.bin.libexecDir, 'sshd-auth'))) {
        lines.push(`SshdAuthPath ${join(this.bin.libexecDir, 'sshd-auth')}`);
      }
    }
    if (c.authorizedKeys) {
      const ak = join(c.dir, 'authorized_keys');
      await writeFile(ak, c.authorizedKeys.join('\n') + '\n', { mode: 0o600 });
      lines.push(`AuthorizedKeysFile ${ak}`);
    } else {
      // Certificate-only: no authorized_keys at all, so unsigned keys fail.
      lines.push('AuthorizedKeysFile none');
    }
    if (c.trustedUserCa) {
      const ca = join(c.dir, 'trusted_user_ca.pub');
      await writeFile(ca, c.trustedUserCa + '\n', { mode: 0o600 });
      lines.push(`TrustedUserCAKeys ${ca}`);
      const pf = join(c.dir, 'principals');
      await writeFile(pf, (c.principals ?? []).join('\n') + '\n', { mode: 0o600 });
      lines.push(`AuthorizedPrincipalsFile ${pf}`);
    }
    if (c.pubkeyAcceptedAlgorithms)
      lines.push(`PubkeyAcceptedAlgorithms ${c.pubkeyAcceptedAlgorithms}`);
    const cfgPath = join(c.dir, 'sshd_config');
    await writeFile(cfgPath, lines.join('\n') + '\n', { mode: 0o600 });

    // Validate config first for a clear error.
    execFileSync(this.bin.sshd, ['-t', '-f', cfgPath], { env: this.bin.env });

    this.proc = spawn(this.bin.sshd, ['-D', '-e', '-f', cfgPath], {
      env: this.bin.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (d: Buffer): void => {
      this.logBuf += d.toString('utf8');
    };
    this.proc.stdout?.on('data', onData);
    this.proc.stderr?.on('data', onData);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('sshd did not start:\n' + this.logBuf)), 10_000);
      const check = (): void => {
        if (this.logBuf.includes(`Server listening on 127.0.0.1 port ${c.port}`)) {
          clearTimeout(t);
          res();
        }
      };
      this.proc?.stderr?.on('data', check);
      this.proc?.once('exit', (code) => {
        clearTimeout(t);
        rej(new Error(`sshd exited (${code}):\n${this.logBuf}`));
      });
    });
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((res) => {
      p.once('exit', () => res());
      p.kill('SIGTERM');
    });
  }
}
