// A real sshd plus a connected ConnectionManager, for service-level tests.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { ConnectionManager } from '../../../src/main/connections/connection-manager';
import { TrustStore } from '../../../src/main/connections/trust-store';
import type { ConnectionSnapshot } from '../../../src/shared/connection';
import type { Profile } from '../../../src/shared/profiles';
import { hostFingerprint, keygen, pub, signCert } from './keys';
import { SshdInstance, freePort, isSftpServerCommand, type SshdBinary } from './sshd';

const PRINCIPAL = 'sftp-test-principal';

export interface FixtureServer {
  server: SshdInstance;
  mgr: ConnectionManager;
  profile: Profile;
  snapshot(): ConnectionSnapshot;
  /** Connect (again) and resolve with the new session id once connected. */
  connect(): Promise<string>;
  /** sshd-session / sftp-server processes serving our connection. */
  sessionPids(): number[];
  /** Command lines of processes descended from the listener (for failure logs). */
  sessionCommands(): string[];
  sftpServerPids(): number[];
  stop(): Promise<void>;
}

export function descendants(pid: number): Array<{ pid: number; comm: string }> {
  const rows = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,comm='])
    .toString()
    .trim()
    .split('\n')
    .map((l) => {
      const [a, b, ...c] = l.trim().split(/\s+/);
      return { pid: Number(a), ppid: Number(b), comm: c.join(' ') };
    });
  const out: Array<{ pid: number; comm: string }> = [];
  const walk = (p: number): void => {
    for (const r of rows) {
      if (r.ppid !== p) continue;
      out.push({ pid: r.pid, comm: r.comm });
      walk(r.pid);
    }
  };
  walk(pid);
  return out;
}

export function signalAll(pids: number[], sig: NodeJS.Signals): void {
  for (const p of pids) {
    try {
      process.kill(p, sig);
    } catch {
      /* already gone */
    }
  }
}

/** sftp-server processes whose command line names this fixture's root. */
function sftpServersByArgs(root: string): number[] {
  let out: string;
  try {
    // -ww: don't truncate the command at the terminal width (the root path is the id).
    out = execFileSync('ps', ['-eww', '-o', 'pid=,args='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[2] ?? '';
    if (isSftpServerCommand(command) && command.includes(root)) pids.push(Number(match[1]));
  }
  return pids;
}

export async function startFixtureServer(opts: {
  bin: SshdBinary;
  root: string;
  sftpRoot: string;
  name?: string;
  sftpServer?: 'internal' | 'external' | 'none';
  keepaliveIntervalMs?: number;
}): Promise<FixtureServer> {
  const K = (n: string): string => join(opts.root, 'keys', n);
  await mkdir(join(opts.root, 'keys'), { recursive: true });
  keygen(K('host'), 'ed25519');
  keygen(K('ca'), 'ed25519');
  keygen(K('user'), 'ed25519');
  signCert({ caPath: K('ca'), keyPath: K('user'), principals: [PRINCIPAL], validity: '-5m:+2h' });
  const server = new SshdInstance(opts.bin, {
    dir: join(opts.root, 'server'),
    port: await freePort(),
    hostKeys: [K('host')],
    sftpRoot: opts.sftpRoot,
    trustedUserCa: pub(K('ca')),
    principals: [PRINCIPAL],
    logLevel: 'INFO',
    sftpServer: opts.sftpServer ?? 'internal',
  });
  await server.start();
  const profile: Profile = {
    id: randomUUID(),
    createdAt: '',
    updatedAt: '',
    name: opts.name ?? 'Fixture',
    host: '127.0.0.1',
    port: server.cfg.port,
    username: userInfo().username,
    authMode: 'privateKeyAndCertificate',
    privateKeyPath: K('user'),
    certificatePath: K('user-cert.pub'),
    initialRemoteDirectory: null,
    downloadDirectory: null,
  };
  await mkdir(join(opts.root, 'state'), { recursive: true });
  const trust = new TrustStore(join(opts.root, 'state'));
  await trust.load();
  await trust.trust({
    host: '127.0.0.1',
    port: server.cfg.port,
    algorithm: 'ssh-ed25519',
    fingerprintSha256: hostFingerprint(K('host.pub')),
  });
  let snap: ConnectionSnapshot | null = null;
  const waiters = new Set<(s: ConnectionSnapshot) => void>();
  const mgr = new ConnectionManager({
    getProfile: (id) => (id === profile.id ? profile : undefined),
    trust,
    emit: (s) => {
      snap = s;
      for (const w of waiters) w(s);
    },
    ...(opts.keepaliveIntervalMs ? { keepaliveIntervalMs: opts.keepaliveIntervalMs } : {}),
  });
  const connect = async (): Promise<string> => {
    const ready = new Promise<void>((res, rej) => {
      const w = (s: ConnectionSnapshot): void => {
        if (s.state === 'connected') {
          waiters.delete(w);
          res();
        } else if (s.state === 'failed') {
          waiters.delete(w);
          rej(new Error(`connect failed: ${s.error?.code}`));
        }
      };
      waiters.add(w);
    });
    const id = await mgr.connect(profile.id);
    await ready;
    return id;
  };
  const kids = (): Array<{ pid: number; comm: string }> =>
    server.pid ? descendants(server.pid) : [];
  return {
    server,
    mgr,
    profile,
    snapshot: () => snap ?? mgr.getSnapshot(),
    connect,
    sessionPids: () => kids().map((k) => k.pid),
    sessionCommands: () => kids().map((k) => k.comm),
    sftpServerPids: () => {
      // `ps -o comm` is the short name on Linux and often the full path on
      // macOS, so match the basename. If sshd reparents the subsystem away
      // from the listener, the `-d <root>` argument is unique to this fixture.
      const fromTree = kids()
        .filter((k) => isSftpServerCommand(k.comm))
        .map((k) => k.pid);
      if (fromTree.length > 0) return fromTree;
      return sftpServersByArgs(opts.sftpRoot);
    },
    stop: async () => {
      await mgr.shutdown();
      await server.stop();
    },
  };
}
