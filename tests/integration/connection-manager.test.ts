// ConnectionManager lifecycle against a real OpenSSH server on 127.0.0.1:
// timeouts (excluding time spent waiting for the user), keepalive loss,
// PerSourcePenalties refusal, cancellation and challenge handling.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectionManager,
  type ConnectionManagerDeps,
} from '../../src/main/connections/connection-manager';
import { TrustStore } from '../../src/main/connections/trust-store';
import type { ConnectionSnapshot } from '../../src/shared/connection';
import type { Profile } from '../../src/shared/profiles';
import { hostFingerprint, keygen, pub, signCert } from './helpers/keys';
import { SshdInstance, findSshd, freePort, type SshdConfig } from './helpers/sshd';

const bin = findSshd();
const USER = userInfo().username;
const PRINCIPAL = 'sftp-test-principal';
const PASSPHRASE = 'correct horse battery staple';
const ROOT = resolve(__dirname, '..', '.tmp', `manager-${process.pid}-${Date.now()}`);
const K = (n: string): string => join(ROOT, 'keys', n);
const servers: SshdInstance[] = [];
let hostFp = '';

async function startServer(name: string, cfg: Partial<SshdConfig> = {}): Promise<SshdInstance> {
  const s = new SshdInstance(bin!, {
    dir: join(ROOT, 'servers', `${name}-${servers.length}`),
    port: await freePort(),
    hostKeys: [K('host_ed25519')],
    sftpRoot: join(ROOT, 'sftp-root'),
    trustedUserCa: pub(K('ca')),
    principals: [PRINCIPAL],
    ...cfg,
  });
  servers.push(s);
  await s.start();
  return s;
}

function profile(port: number, over: Partial<Profile> = {}): Profile {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: `p${port}`,
    host: '127.0.0.1',
    port,
    username: USER,
    authMode: 'privateKeyAndCertificate',
    privateKeyPath: K('ed'),
    certificatePath: K('ed-cert.pub'),
    initialRemoteDirectory: null,
    downloadDirectory: null,
    ...over,
  };
}

interface Harness {
  mgr: ConnectionManager;
  trust: TrustStore;
  states: ConnectionSnapshot[];
  waitFor(pred: (s: ConnectionSnapshot) => boolean, ms?: number): Promise<ConnectionSnapshot>;
}

async function harness(
  profiles: Profile[],
  extra: Partial<ConnectionManagerDeps> = {},
  trustHost = true,
): Promise<Harness> {
  const dir = join(ROOT, 'state', randomUUID());
  await mkdir(dir, { recursive: true });
  const trust = new TrustStore(dir);
  await trust.load();
  if (trustHost) {
    for (const p of profiles) {
      await trust.trust({
        host: p.host,
        port: p.port,
        algorithm: 'ssh-ed25519',
        fingerprintSha256: hostFp,
      });
    }
  }
  const states: ConnectionSnapshot[] = [];
  const waiters = new Set<() => void>();
  const mgr = new ConnectionManager({
    getProfile: (id) => profiles.find((p) => p.id === id),
    trust,
    emit: (s) => {
      states.push(s);
      for (const w of waiters) w();
    },
    ...extra,
  });
  const waitFor = (
    pred: (s: ConnectionSnapshot) => boolean,
    ms = 20_000,
  ): Promise<ConnectionSnapshot> =>
    new Promise((res, rej) => {
      const check = (): void => {
        const s = mgr.getSnapshot();
        if (pred(s)) {
          waiters.delete(check);
          clearTimeout(t);
          res(s);
        }
      };
      const t = setTimeout(() => {
        waiters.delete(check);
        rej(new Error(`timed out; states: ${states.map((x) => x.state).join(' → ')}`));
      }, ms);
      waiters.add(check);
      check();
    });
  return { mgr, trust, states, waitFor };
}

/** All live descendants of a pid (sshd-session and friends). */
function descendants(pid: number): number[] {
  const out = execFileSync('ps', ['-e', '-o', 'pid=,ppid=']).toString();
  const rows = out
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const result: number[] = [];
  const walk = (p: number): void => {
    for (const [c, pp] of rows) {
      if (pp !== p) continue;
      result.push(c);
      walk(c);
    }
  };
  walk(pid);
  return result;
}

describe.skipIf(!bin)('ConnectionManager against real sshd', () => {
  let server: SshdInstance;

  beforeAll(async () => {
    await mkdir(join(ROOT, 'keys'), { recursive: true });
    await mkdir(join(ROOT, 'sftp-root'), { recursive: true });
    keygen(K('host_ed25519'), 'ed25519');
    keygen(K('ca'), 'ed25519');
    keygen(K('ed'), 'ed25519');
    keygen(K('ed_enc'), 'ed25519', PASSPHRASE);
    signCert({ caPath: K('ca'), keyPath: K('ed'), principals: [PRINCIPAL], validity: '-5m:+1h' });
    signCert({
      caPath: K('ca'),
      keyPath: K('ed_enc'),
      principals: [PRINCIPAL],
      validity: '-5m:+1h',
    });
    hostFp = hostFingerprint(K('host_ed25519.pub'));
    server = await startServer('main');
  }, 120_000);

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    if (!process.env.KEEP_TEST_TMP) await rm(ROOT, { recursive: true, force: true });
  });

  it('connects, reports the remote home and disconnects cleanly', async () => {
    const p = profile(server.cfg.port);
    const h = await harness([p]);
    const sid = await h.mgr.connect(p.id);
    const s = await h.waitFor((x) => x.state === 'connected');
    expect(s.remoteHome).toBe(join(ROOT, 'sftp-root'));
    await h.mgr.disconnect(sid);
    expect(h.mgr.getSnapshot()).toMatchObject({ state: 'disconnected', error: null });
    expect(h.states.map((x) => x.state)).toEqual([
      'connecting',
      'connected',
      'disconnecting',
      'disconnected',
    ]);
  });

  it('times out against a server that accepts TCP but never speaks SSH', async () => {
    const sockets: Socket[] = [];
    const silent: Server = createServer((sock) => sockets.push(sock));
    const port = await freePort();
    await new Promise<void>((r) => silent.listen(port, '127.0.0.1', r));
    try {
      const p = profile(port);
      const h = await harness([p], { timeoutMs: 1500 });
      const t0 = Date.now();
      await h.mgr.connect(p.id);
      const s = await h.waitFor((x) => x.state === 'failed');
      const elapsed = Date.now() - t0;
      expect(s.error?.code).toBe('TIMEOUT');
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => silent.close(r));
    }
  });

  it('the timeout excludes time spent on the trust and passphrase dialogs', async () => {
    const p = profile(server.cfg.port, {
      privateKeyPath: K('ed_enc'),
      certificatePath: K('ed_enc-cert.pub'),
    });
    const h = await harness([p], { timeoutMs: 1500 }, false);
    await h.mgr.connect(p.id);
    let s = await h.waitFor((x) => x.state === 'awaitingPassphrase');
    await new Promise((r) => setTimeout(r, 2500)); // user is slow to type
    h.mgr.submitPassphrase(s.challenge!.challengeId, PASSPHRASE);
    s = await h.waitFor((x) => x.state === 'awaitingHostTrust');
    expect(s.challenge).toMatchObject({
      kind: 'hostTrust',
      hostKey: { fingerprintSha256: hostFp },
    });
    await new Promise((r) => setTimeout(r, 2500)); // user compares the fingerprint
    h.mgr.acceptTrust(s.challenge!.challengeId);
    s = await h.waitFor((x) => x.state === 'connected' || x.state === 'failed');
    expect(s.state, JSON.stringify(s.error)).toBe('connected');
    expect(
      h.trust.evaluate({
        host: '127.0.0.1',
        port: server.cfg.port,
        algorithm: 'ssh-ed25519',
        fingerprintSha256: hostFp,
      }).kind,
    ).toBe('trusted');
    await h.mgr.shutdown();
  });

  it('stale or mismatched challenge replies are refused; the real one still works', async () => {
    const p = profile(server.cfg.port);
    const h = await harness([p], {}, false);
    await h.mgr.connect(p.id);
    const s = await h.waitFor((x) => x.state === 'awaitingHostTrust');
    expect(() => h.mgr.acceptTrust(randomUUID())).toThrow(/no longer current/);
    expect(() => h.mgr.submitPassphrase(s.challenge!.challengeId, 'x')).toThrow(
      /no longer current/,
    );
    h.mgr.rejectTrust(s.challenge!.challengeId);
    await h.waitFor((x) => x.state === 'disconnected');
    expect(() => h.mgr.acceptTrust(s.challenge!.challengeId)).toThrow(/no longer current/);
    expect(h.trust.list()).toEqual([]);
  });

  it('cancel during connect ends in disconnected with no error', async () => {
    const p = profile(server.cfg.port, {
      privateKeyPath: K('ed_enc'),
      certificatePath: K('ed_enc-cert.pub'),
    });
    const h = await harness([p]);
    const sid = await h.mgr.connect(p.id);
    await h.waitFor((x) => x.state === 'awaitingPassphrase');
    h.mgr.cancel(sid);
    expect(h.mgr.getSnapshot()).toMatchObject({
      state: 'disconnected',
      error: null,
      challenge: null,
    });
  });

  it('wrong passphrase asks again (retry) without failing the attempt', async () => {
    const p = profile(server.cfg.port, {
      privateKeyPath: K('ed_enc'),
      certificatePath: K('ed_enc-cert.pub'),
    });
    const h = await harness([p]);
    await h.mgr.connect(p.id);
    let s = await h.waitFor((x) => x.state === 'awaitingPassphrase');
    expect(s.challenge).toMatchObject({ kind: 'passphrase', retry: false, keyFileName: 'ed_enc' });
    h.mgr.submitPassphrase(s.challenge!.challengeId, 'wrong');
    s = await h.waitFor(
      (x) =>
        x.state === 'awaitingPassphrase' && x.challenge?.kind === 'passphrase' && x.challenge.retry,
    );
    h.mgr.submitPassphrase(s.challenge!.challengeId, PASSPHRASE);
    await h.waitFor((x) => x.state === 'connected');
    await h.mgr.shutdown();
  });

  it('reports CONNECTION_LOST when the server stops answering keepalives', async () => {
    const lossServer = await startServer('keepalive');
    const p = profile(lossServer.cfg.port);
    const h = await harness([p], { keepaliveIntervalMs: 500, keepaliveCountMax: 3 });
    await h.mgr.connect(p.id);
    await h.waitFor((x) => x.state === 'connected');
    const frozen = descendants(lossServer.pid!);
    expect(frozen.length).toBeGreaterThan(0);
    for (const pid of frozen) process.kill(pid, 'SIGSTOP');
    try {
      const t0 = Date.now();
      const s = await h.waitFor((x) => x.state === 'disconnected', 10_000);
      expect(s.error?.code).toBe('CONNECTION_LOST');
      // 3 missed keepalives at 500 ms, not the TCP timeout.
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      for (const pid of frozen) {
        try {
          process.kill(pid, 'SIGCONT');
        } catch {
          // gone
        }
      }
    }
  });

  it('a PerSourcePenalties block is reported as SERVER_REFUSED, not a generic network error', async () => {
    // Real OpenSSH penalty: one failed login blocks this source for 30 s.
    const strict = await startServer('penalty', {
      perSourcePenalties: 'authfail:30s noauth:30s min:1s',
    });
    const bad = profile(strict.cfg.port, { authMode: 'privateKey', certificatePath: null });
    const h = await harness([bad]);
    await h.mgr.connect(bad.id);
    let s = await h.waitFor((x) => x.state === 'failed');
    expect(s.error?.code).toBe('AUTH_REJECTED');
    // sshd applies the penalty when the failed session ends.
    await new Promise((r) => setTimeout(r, 1000));
    await h.mgr.connect(bad.id);
    s = await h.waitFor((x) => x.state === 'failed');
    expect(
      s.error?.code,
      strict.log
        .split('\n')
        .filter((l) => /penalt/i.test(l))
        .join('\n'),
    ).toBe('SERVER_REFUSED');
    expect(strict.log).toMatch(/penalt/i);
  });
});
