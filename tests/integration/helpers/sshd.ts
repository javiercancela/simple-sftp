// Real OpenSSH server fixture. Runs sshd unprivileged, bound to 127.0.0.1
// only, with throwaway keys generated under tests/.tmp (gitignored).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface SshdBinary {
  sshd: string;
  /** Directory containing sshd-session, when this OpenSSH split the binaries. */
  libexecDir: string | undefined;
  /** External sftp-server, when one exists. Undefined means "not on this host". */
  sftpServer: string | undefined;
  env: NodeJS.ProcessEnv;
}

/**
 * Locate sshd. Order: $SFTP_TEST_SSHD, /usr/sbin/sshd, /usr/local/sbin/sshd,
 * the binary extracted by scripts/fetch-test-sshd-debian.sh.
 * $SFTP_TEST_SSHD_LD_LIBRARY_PATH is added to the child environment when set
 * (for an sshd extracted from a .deb rather than installed).
 *
 * sftp-server is located separately. OpenSSH < 9.8 has no sshd-session, so
 * tying the lookup to that binary misses Debian/Ubuntu's
 * /usr/lib/openssh/sftp-server.
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
  const resolved = resolve(sshd);
  const libexecCandidates = [
    process.env.SFTP_TEST_SSHD_LIBEXEC,
    join(dirname(resolved), '..', 'lib', 'openssh'),
    join(dirname(resolved), '..', 'libexec'),
  ];
  const libexecDir = libexecCandidates.find(
    (c): c is string => !!c && existsSync(join(c, 'sshd-session')),
  );
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (process.env.SFTP_TEST_SSHD_LD_LIBRARY_PATH) {
    env.LD_LIBRARY_PATH = process.env.SFTP_TEST_SSHD_LD_LIBRARY_PATH;
  } else if (resolved.startsWith(repoTools)) {
    env.LD_LIBRARY_PATH = join(repoTools, 'usr', 'lib', 'x86_64-linux-gnu');
  }
  const resolvedLibexec = libexecDir && resolve(libexecDir);
  return {
    sshd: resolved,
    libexecDir: resolvedLibexec,
    sftpServer: findSftpServer(resolved, resolvedLibexec, env),
    env,
  };
}

/** argv0 is the sftp-server binary, whatever directory it lives in. */
export function isSftpServerCommand(command: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? '';
  return argv0.split(/[/\\]/).pop() === 'sftp-server';
}

/**
 * First `subsystem sftp <path>` from `sshd -T` output.
 * `internal-sftp` is not a binary and yields undefined.
 */
export function sftpServerPathFromSshdT(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^subsystem\s+sftp\s+(\S+)/i.exec(line.trim());
    if (!match) continue;
    const token = match[1] ?? '';
    if (token === 'internal-sftp' || token.startsWith('internal-sftp')) return undefined;
    return token;
  }
  return undefined;
}

/** True when sshd's stderr says it does not recognise PerSourcePenalties. */
export function sshdStderrRejectsPerSourcePenalties(stderr: string): boolean {
  return (
    /bad configuration option:\s*persourcepenalties/i.test(stderr) ||
    /unsupported option:?\s*["']?persourcepenalties/i.test(stderr)
  );
}

const penaltySupport = new Map<string, boolean>();

/**
 * OpenSSH >= 9.8 accepts PerSourcePenalties. Older sshd (Ubuntu 24.04's 9.6)
 * rejects the keyword, so the fixture must not emit it.
 * Probe with `sshd -t` rather than parsing the version string: vendors backport.
 */
export function sshdSupportsPerSourcePenalties(bin: SshdBinary): boolean {
  const cached = penaltySupport.get(bin.sshd);
  if (cached !== undefined) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'sshd-probe-'));
  const cfg = join(dir, 'sshd_config');
  let supported = false;
  try {
    writeFileSync(cfg, 'PerSourcePenalties no\n', { mode: 0o600 });
    try {
      execFileSync(bin.sshd, ['-t', '-f', cfg], {
        env: bin.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      supported = true;
    } catch (e) {
      supported = !sshdStderrRejectsPerSourcePenalties(execOutput(e));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  penaltySupport.set(bin.sshd, supported);
  return supported;
}

function findSftpServer(
  sshd: string,
  libexecDir: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const beside = dirname(sshd);
  const candidates = [
    process.env.SFTP_TEST_SFTP_SERVER,
    libexecDir && join(libexecDir, 'sftp-server'),
    join(beside, 'sftp-server'),
    join(beside, '..', 'lib', 'openssh', 'sftp-server'), // Debian, Ubuntu
    join(beside, '..', 'libexec', 'openssh', 'sftp-server'), // Fedora, RHEL
    join(beside, '..', 'libexec', 'sftp-server'), // macOS, some BSDs
    '/usr/lib/openssh/sftp-server',
    '/usr/libexec/openssh/sftp-server',
    '/usr/libexec/sftp-server',
    '/usr/local/libexec/sftp-server',
    '/usr/local/libexec/openssh/sftp-server',
    '/opt/homebrew/libexec/sftp-server',
    '/opt/homebrew/libexec/openssh/sftp-server',
    '/opt/homebrew/opt/openssh/libexec/sftp-server',
    '/usr/local/opt/openssh/libexec/sftp-server',
  ];
  const found = candidates.find((c): c is string => !!c && existsSync(c));
  if (found) return resolve(found);
  const fromConfig = sftpServerPathFromSshdT(sshdEffectiveConfig(sshd, env));
  if (fromConfig && existsSync(fromConfig)) return resolve(fromConfig);
  return undefined;
}

function sshdEffectiveConfig(sshd: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(sshd, ['-T'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return execOutput(e);
  }
}

function execOutput(e: unknown): string {
  if (!e || typeof e !== 'object') return '';
  const err = e as { stdout?: unknown; stderr?: unknown; message?: string };
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return `${text(err.stdout)}\n${text(err.stderr)}\n${err.message ?? ''}`;
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
    ];
    // OpenSSH >= 9.8 penalizes sources after failed auths and the option is on
    // by default. Tests fail auth on purpose, so disable it when the binary
    // accepts the keyword. Older sshd has no penalties; emitting the keyword
    // makes `sshd -t` fail (Ubuntu 24.04 ships 9.6).
    const penalties = c.perSourcePenalties ?? 'no';
    if (sshdSupportsPerSourcePenalties(this.bin)) {
      lines.push(`PerSourcePenalties ${penalties}`);
    } else if (c.perSourcePenalties !== undefined && c.perSourcePenalties !== 'no') {
      throw new Error(
        'This OpenSSH does not support PerSourcePenalties (sshd -t rejected the option). Refusing to start a fixture that would not enforce the requested penalty.',
      );
    }
    if (c.sftpServer === 'none') {
      // No subsystem and no forced command: the sftp request is refused.
    } else if (c.sftpServer === 'external') {
      const server = this.bin.sftpServer;
      if (!server)
        throw new Error(
          'sftp-server binary not found (set SFTP_TEST_SFTP_SERVER, or install OpenSSH so a common path or `sshd -T` subsystem line points at it)',
        );
      const ld = this.bin.env.LD_LIBRARY_PATH
        ? `env LD_LIBRARY_PATH=${this.bin.env.LD_LIBRARY_PATH} `
        : '';
      // Subsystem and ForceCommand both name the external binary. Some sshd
      // builds apply only one of them to an sftp subsystem request; either way
      // the process is sftp-server, which tests can signal.
      lines.push(`Subsystem sftp ${server} -d ${c.sftpRoot}`);
      lines.push(`ForceCommand ${ld}${server} -d ${c.sftpRoot}`);
    } else {
      lines.push('Subsystem sftp internal-sftp');
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
    // Per-connection sshd-session processes outlive the listener, and tests
    // freeze them with SIGSTOP: kill them explicitly (SIGKILL also ends stopped
    // processes) so no test server is left behind.
    for (const child of descendantPids(p.pid!)) {
      try {
        process.kill(child, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    await new Promise<void>((res) => {
      p.once('exit', () => res());
      p.kill('SIGTERM');
    });
  }
}

function descendantPids(root: number): number[] {
  const rows = execFileSync('ps', ['-e', '-o', 'pid=,ppid='])
    .toString()
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const out: number[] = [];
  const walk = (pid: number): void => {
    for (const [c, pp] of rows) {
      if (pp !== pid) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}
