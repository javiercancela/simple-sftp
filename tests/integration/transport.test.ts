// Release-blocking transport checks (spec 3.2) against a real OpenSSH server.
// No mocks: every case below talks to sshd over 127.0.0.1.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadCredentials,
  parseCredentialMaterial,
  type LoadedCredentials,
} from '../../src/main/connections/credentials';
import { TransportError } from '../../src/main/connections/errors';
import { evaluateHostKey, type TrustedHostRecord } from '../../src/main/connections/host-key';
import { connect, type SftpSession } from '../../src/main/connections/transport';
import type { HostKeyInfo } from '../../src/shared/transport-contract';
import { hostFingerprint, keygen, pub, signCert } from './helpers/keys';
import { SshdInstance, findSshd, freePort, type SshdConfig } from './helpers/sshd';

const bin = findSshd();
const USER = userInfo().username;
const PRINCIPAL = 'sftp-test-principal';
const PASSPHRASE = 'correct horse battery staple';
const ROOT = resolve(__dirname, '..', '.tmp', `transport-${process.pid}-${Date.now()}`);
const K = (n: string): string => join(ROOT, 'keys', n);

let hostEdFp = '';
let hostRsaFp = '';
const fileHashes = new Map<string, string>();
const servers: SshdInstance[] = [];

async function sha256File(p: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(p), h);
  return h.digest('hex');
}

async function startServer(
  name: string,
  cfg: Omit<SshdConfig, 'dir' | 'port' | 'sftpRoot'> & { port?: number },
): Promise<SshdInstance> {
  if (!bin) throw new Error('sshd not found');
  const s = new SshdInstance(bin, {
    ...cfg,
    dir: join(ROOT, 'servers', `${name}-${servers.length}`),
    port: cfg.port ?? (await freePort()),
    sftpRoot: join(ROOT, 'sftp-root'),
  });
  servers.push(s);
  await s.start();
  return s;
}

/** Pin the expected test host key (the app would ask the user here). */
const pinnedVerifier =
  (...allowed: string[]) =>
  async (info: HostKeyInfo): Promise<boolean> =>
    allowed.includes(info.fingerprintSha256);

async function connectWith(
  server: SshdInstance,
  creds: LoadedCredentials,
  extra: { verifyHost?: (i: HostKeyInfo) => Promise<boolean>; debug?: (l: string) => void } = {},
): Promise<SftpSession> {
  return connect({
    host: '127.0.0.1',
    port: server.cfg.port,
    username: USER,
    credentials: creds,
    verifyHost: extra.verifyHost ?? pinnedVerifier(hostEdFp, hostRsaFp),
    timeoutMs: 15_000,
    ...(extra.debug ? { debug: extra.debug } : {}),
  });
}

async function expectCode(p: Promise<unknown>, code: string): Promise<TransportError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe(code);
    return err as TransportError;
  }
  throw new Error(`expected ${code}, but it succeeded`);
}

async function assertConnectsAndLists(
  server: SshdInstance,
  creds: LoadedCredentials,
): Promise<void> {
  const s = await connectWith(server, creds);
  try {
    const home = await s.realpath('.');
    expect(home).toBe(join(ROOT, 'sftp-root'));
    const names = (await s.list(home)).map((e) => e.name);
    expect(names).toContain('hello.txt');
  } finally {
    await s.disconnect();
  }
}

describe.skipIf(!bin)('OpenSSH transport (real sshd on 127.0.0.1)', () => {
  beforeAll(async () => {
    await mkdir(join(ROOT, 'keys'), { recursive: true });
    // Host keys
    keygen(K('host_ed25519'), 'ed25519');
    keygen(K('host_ed25519_changed'), 'ed25519');
    keygen(K('host_rsa'), 'rsa');
    hostEdFp = hostFingerprint(K('host_ed25519.pub'));
    hostRsaFp = hostFingerprint(K('host_rsa.pub'));
    // User keys
    keygen(K('ed'), 'ed25519');
    keygen(K('ed_other'), 'ed25519');
    keygen(K('rsa'), 'rsa');
    keygen(K('ed_enc'), 'ed25519', PASSPHRASE);
    keygen(K('rsa_enc'), 'rsa', PASSPHRASE);
    // CAs
    keygen(K('ca'), 'ed25519');
    keygen(K('wrong_ca'), 'ed25519');
    // Certificates
    signCert({ caPath: K('ca'), keyPath: K('ed'), principals: [PRINCIPAL], validity: '-5m:+1h' });
    signCert({ caPath: K('ca'), keyPath: K('rsa'), principals: [PRINCIPAL], validity: '-5m:+1h' });
    signCert({
      caPath: K('ca'),
      keyPath: K('ed_enc'),
      principals: [PRINCIPAL],
      validity: '-5m:+1h',
    });
    signCert({
      caPath: K('ca'),
      keyPath: K('rsa_enc'),
      principals: [PRINCIPAL],
      validity: '-5m:+1h',
    });
    signCert({
      caPath: K('ca'),
      keyPath: K('ed'),
      principals: [PRINCIPAL],
      validity: '20200101:20200102',
      outName: K('ed-expired-cert.pub'),
    });
    signCert({
      caPath: K('ca'),
      keyPath: K('ed'),
      principals: ['someone-else'],
      validity: '-5m:+1h',
      outName: K('ed-wrong-principal-cert.pub'),
    });
    signCert({
      caPath: K('wrong_ca'),
      keyPath: K('ed'),
      principals: [PRINCIPAL],
      validity: '-5m:+1h',
      outName: K('ed-wrong-ca-cert.pub'),
    });

    // SFTP content
    const root = join(ROOT, 'sftp-root');
    await mkdir(join(root, 'dir with space'), { recursive: true });
    await mkdir(join(root, 'empty-dir'));
    await mkdir(join(root, 'no-access'));
    await writeFile(join(root, 'hello.txt'), 'hello over sftp\n');
    await writeFile(join(root, 'empty.bin'), Buffer.alloc(0));
    await writeFile(join(root, 'random-8MiB.bin'), randomBytes(8 * 1024 * 1024));
    await writeFile(join(root, 'dir with space', 'ñandú ☃.txt'), 'unicode name\n');
    await writeFile(join(root, '.hidden'), 'hidden\n');
    await symlink('dir with space', join(root, 'link-to-dir'));
    for (const f of ['hello.txt', 'empty.bin', 'random-8MiB.bin']) {
      fileHashes.set(f, await sha256File(join(root, f)));
    }
    await chmod(join(root, 'no-access'), 0o000);
  }, 120_000);

  afterAll(async () => {
    for (const s of servers) await s.stop();
    await chmod(join(ROOT, 'sftp-root', 'no-access'), 0o700).catch(() => undefined);
    if (!process.env.KEEP_TEST_TMP) await rm(ROOT, { recursive: true, force: true });
  });

  describe('plain-key server (authorized_keys)', () => {
    let server: SshdInstance;
    beforeAll(async () => {
      server = await startServer('plain', {
        hostKeys: [K('host_ed25519')],
        authorizedKeys: [pub(K('ed')), pub(K('rsa')), pub(K('ed_enc')), pub(K('rsa_enc'))],
      });
    });

    it('authenticates with an Ed25519 key', async () => {
      await assertConnectsAndLists(server, await loadCredentials({ privateKeyPath: K('ed') }));
    });

    it('authenticates with an RSA key (SHA-2 signature)', async () => {
      server.clearLog();
      await assertConnectsAndLists(server, await loadCredentials({ privateKeyPath: K('rsa') }));
      expect(server.log).toMatch(/Accepted publickey for \S+ from 127\.0\.0\.1 .* RSA SHA256:/);
      expect(server.log).toMatch(/attempting public key rsa-sha2-(256|512) /);
      expect(server.log).not.toMatch(/attempting public key ssh-rsa /);
    });

    it('authenticates with an encrypted Ed25519 key and the right passphrase', async () => {
      await assertConnectsAndLists(
        server,
        await loadCredentials({ privateKeyPath: K('ed_enc'), passphrase: PASSPHRASE }),
      );
    });

    it('authenticates with an encrypted RSA key and the right passphrase', async () => {
      await assertConnectsAndLists(
        server,
        await loadCredentials({ privateKeyPath: K('rsa_enc'), passphrase: PASSPHRASE }),
      );
    });

    it('wrong passphrase is a recoverable local error, then the right one works', async () => {
      await expectCode(
        loadCredentials({ privateKeyPath: K('ed_enc'), passphrase: 'nope' }),
        'PASSPHRASE_INCORRECT',
      );
      await expectCode(
        loadCredentials({ privateKeyPath: K('rsa_enc'), passphrase: 'nope' }),
        'PASSPHRASE_INCORRECT',
      );
      await expectCode(loadCredentials({ privateKeyPath: K('ed_enc') }), 'PASSPHRASE_REQUIRED');
      await assertConnectsAndLists(
        server,
        await loadCredentials({ privateKeyPath: K('ed_enc'), passphrase: PASSPHRASE }),
      );
    });

    it('rejects an unauthorized key', async () => {
      await expectCode(
        connectWith(server, await loadCredentials({ privateKeyPath: K('ed_other') })),
        'AUTH_REJECTED',
      );
    });
  });

  for (const alg of ['rsa-sha2-256', 'rsa-sha2-512'] as const) {
    it(`plain RSA key when server only accepts ${alg}`, async () => {
      const server = await startServer(`plain-${alg}`, {
        hostKeys: [K('host_ed25519')],
        authorizedKeys: [pub(K('rsa'))],
        pubkeyAcceptedAlgorithms: alg,
      });
      await assertConnectsAndLists(server, await loadCredentials({ privateKeyPath: K('rsa') }));
      expect(server.log).toContain(`attempting public key ${alg} `);
      expect(server.log).toMatch(/Accepted publickey/);
    });
  }

  describe('certificate-only server (TrustedUserCAKeys + AuthorizedPrincipalsFile)', () => {
    let server: SshdInstance;
    beforeAll(async () => {
      server = await startServer('cert', {
        hostKeys: [K('host_ed25519')],
        trustedUserCa: pub(K('ca')),
        principals: [PRINCIPAL],
      });
    });

    it('authenticates with Ed25519 key + valid certificate', async () => {
      server.clearLog();
      await assertConnectsAndLists(
        server,
        await loadCredentials({ privateKeyPath: K('ed'), certificatePath: K('ed-cert.pub') }),
      );
      expect(server.log).toMatch(
        /Accepted certificate ID "sftp-client-test" .* signed by ED25519 CA/,
      );
      expect(server.log).toMatch(/Accepted publickey for \S+ .* ED25519-CERT SHA256:/);
    });

    it('authenticates with encrypted Ed25519 key + valid certificate', async () => {
      await assertConnectsAndLists(
        server,
        await loadCredentials({
          privateKeyPath: K('ed_enc'),
          certificatePath: K('ed_enc-cert.pub'),
          passphrase: PASSPHRASE,
        }),
      );
    });

    it('rejects the plain (unsigned) public key', async () => {
      server.clearLog();
      await expectCode(
        connectWith(server, await loadCredentials({ privateKeyPath: K('ed') })),
        'AUTH_REJECTED',
      );
      expect(server.log).not.toMatch(/Accepted publickey/);
    });

    it('expired certificate: blocked locally before connecting', async () => {
      await expectCode(
        loadCredentials({ privateKeyPath: K('ed'), certificatePath: K('ed-expired-cert.pub') }),
        'CERT_EXPIRED',
      );
    });

    it('expired certificate: server also rejects it (local check bypassed via clock)', async () => {
      // Pretend local clock is inside the 2020 validity window; the server uses
      // the real time and must refuse.
      const creds = await loadCredentials(
        { privateKeyPath: K('ed'), certificatePath: K('ed-expired-cert.pub') },
        { nowSeconds: BigInt(Date.UTC(2020, 0, 1, 12) / 1000) },
      );
      server.clearLog();
      await expectCode(connectWith(server, creds), 'AUTH_REJECTED');
      expect(server.log).toMatch(/cert.*expired|Certificate invalid: expired/i);
    });

    it('rejects a certificate with the wrong principal', async () => {
      server.clearLog();
      await expectCode(
        connectWith(
          server,
          await loadCredentials({
            privateKeyPath: K('ed'),
            certificatePath: K('ed-wrong-principal-cert.pub'),
          }),
        ),
        'AUTH_REJECTED',
      );
      expect(server.log).not.toMatch(/Accepted publickey/);
    });

    it('rejects a certificate signed by an untrusted CA', async () => {
      server.clearLog();
      await expectCode(
        connectWith(
          server,
          await loadCredentials({
            privateKeyPath: K('ed'),
            certificatePath: K('ed-wrong-ca-cert.pub'),
          }),
        ),
        'AUTH_REJECTED',
      );
      expect(server.log).not.toMatch(/Accepted publickey/);
    });

    it('mismatched key/certificate: blocked locally', async () => {
      await expectCode(
        loadCredentials({ privateKeyPath: K('ed_other'), certificatePath: K('ed-cert.pub') }),
        'CERT_KEY_MISMATCH',
      );
    });

    it('mismatched key/certificate: server also rejects it (local check skipped)', async () => {
      const creds = parseCredentialMaterial(
        await readFile(K('ed_other')),
        await readFile(K('ed-cert.pub')),
        undefined,
      );
      server.clearLog();
      await expectCode(connectWith(server, creds), 'AUTH_REJECTED');
      expect(server.log).not.toMatch(/Accepted publickey/);
    });

    it('a plain .pub file is not accepted as a certificate', async () => {
      await expectCode(
        loadCredentials({ privateKeyPath: K('ed'), certificatePath: K('ed.pub') }),
        'CERT_NOT_A_CERTIFICATE',
      );
    });

    it('reads credential files fresh on each attempt (renewed cert works without restart)', async () => {
      const certPath = join(ROOT, 'keys', 'renewable-cert.pub');
      await writeFile(certPath, await readFile(K('ed-expired-cert.pub')));
      await expectCode(
        loadCredentials({ privateKeyPath: K('ed'), certificatePath: certPath }),
        'CERT_EXPIRED',
      );
      await writeFile(certPath, await readFile(K('ed-cert.pub')));
      await assertConnectsAndLists(
        server,
        await loadCredentials({ privateKeyPath: K('ed'), certificatePath: certPath }),
      );
    });
  });

  // RSA user certificates: the cert path in @electerm/ssh2 picks the signature
  // algorithm separately, so cover both SHA-2 variants and both host-key setups.
  for (const hostSetup of ['ed25519-host-only', 'ed25519+rsa-hosts'] as const) {
    for (const alg of ['rsa-sha2-256', 'rsa-sha2-512'] as const) {
      it(`RSA key + certificate, server accepts only ${alg}-cert, ${hostSetup}`, async () => {
        const server = await startServer(`cert-rsa-${alg}-${hostSetup}`, {
          hostKeys:
            hostSetup === 'ed25519-host-only'
              ? [K('host_ed25519')]
              : [K('host_ed25519'), K('host_rsa')],
          trustedUserCa: pub(K('ca')),
          principals: [PRINCIPAL],
          pubkeyAcceptedAlgorithms: `${alg}-cert-v01@openssh.com`,
        });
        await assertConnectsAndLists(
          server,
          await loadCredentials({ privateKeyPath: K('rsa'), certificatePath: K('rsa-cert.pub') }),
        );
        expect(server.log).toContain(`attempting public key ${alg}-cert-v01@openssh.com `);
        expect(server.log).toMatch(/Accepted certificate ID .* signed by ED25519 CA/);
      });
    }
  }

  it('encrypted RSA key + certificate (default server algorithms)', async () => {
    const server = await startServer('cert-rsa-enc', {
      hostKeys: [K('host_ed25519')],
      trustedUserCa: pub(K('ca')),
      principals: [PRINCIPAL],
    });
    await assertConnectsAndLists(
      server,
      await loadCredentials({
        privateKeyPath: K('rsa_enc'),
        certificatePath: K('rsa_enc-cert.pub'),
        passphrase: PASSPHRASE,
      }),
    );
  });

  describe('host key verification', () => {
    it('first trust shows SHA-256 fingerprint + algorithm, then connects after acceptance', async () => {
      const server = await startServer('host-first', {
        hostKeys: [K('host_ed25519')],
        trustedUserCa: pub(K('ca')),
        principals: [PRINCIPAL],
      });
      const seen: HostKeyInfo[] = [];
      const s = await connectWith(
        server,
        await loadCredentials({ privateKeyPath: K('ed'), certificatePath: K('ed-cert.pub') }),
        {
          verifyHost: async (info) => {
            seen.push(info);
            return true;
          },
        },
      );
      await s.disconnect();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({
        host: '127.0.0.1',
        port: server.cfg.port,
        algorithm: 'ssh-ed25519',
        fingerprintSha256: hostEdFp,
      });
    });

    it('cancelling trust closes the transport before any user authentication is sent', async () => {
      const server = await startServer('host-cancel', {
        hostKeys: [K('host_ed25519')],
        trustedUserCa: pub(K('ca')),
        principals: [PRINCIPAL],
      });
      const debugLines: string[] = [];
      let asked = 0;
      await expectCode(
        connectWith(
          server,
          await loadCredentials({ privateKeyPath: K('ed'), certificatePath: K('ed-cert.pub') }),
          {
            verifyHost: async () => {
              asked++;
              await new Promise((r) => setTimeout(r, 200)); // user thinking
              return false;
            },
            debug: (l) => debugLines.push(l),
          },
        ),
        'HOST_KEY_REJECTED',
      );
      expect(asked).toBe(1);
      await new Promise((r) => setTimeout(r, 500)); // let sshd flush its log
      const clientLog = debugLines.join('\n');
      expect(clientLog).toMatch(/KEXINIT/); // probe sanity: debug capture works
      expect(clientLog).not.toMatch(/USERAUTH_REQUEST/);
      expect(clientLog).not.toMatch(/SERVICE_REQUEST/);
      expect(server.log).toMatch(/Connection from 127\.0\.0\.1/);
      expect(server.log).not.toMatch(/userauth-request/);
      expect(server.log).not.toMatch(/Accepted/);

      // Probe sanity: an accepted connection does show these markers.
      const okLines: string[] = [];
      server.clearLog();
      const s = await connectWith(
        server,
        await loadCredentials({ privateKeyPath: K('ed'), certificatePath: K('ed-cert.pub') }),
        { debug: (l) => okLines.push(l) },
      );
      await s.disconnect();
      expect(okLines.join('\n')).toMatch(/USERAUTH_REQUEST/);
      expect(server.log).toMatch(/userauth-request/);
    });

    it('a changed host key is blocked with expected and received fingerprints', async () => {
      const port = await freePort();
      const store = new Map<string, TrustedHostRecord>();
      const verifier = async (info: HostKeyInfo): Promise<boolean> => {
        const key = `${info.host}:${info.port}`;
        const ev = evaluateHostKey(store.get(key), info);
        if (ev.kind === 'trusted') return true;
        if (ev.kind === 'unknown') {
          store.set(key, { ...info }); // user clicked "Trust and connect"
          return true;
        }
        throw new TransportError(
          'HOST_KEY_MISMATCH',
          'The server host key changed.',
          `expected ${ev.expected.fingerprintSha256}, received ${info.fingerprintSha256}`,
        );
      };
      const creds = await loadCredentials({
        privateKeyPath: K('ed'),
        certificatePath: K('ed-cert.pub'),
      });
      const first = await startServer('host-orig', {
        port,
        hostKeys: [K('host_ed25519')],
        trustedUserCa: pub(K('ca')),
        principals: [PRINCIPAL],
      });
      (await connectWith(first, creds, { verifyHost: verifier })).disconnect();
      await first.stop();

      const changed = await startServer('host-changed', {
        port,
        hostKeys: [K('host_ed25519_changed')],
        trustedUserCa: pub(K('ca')),
        principals: [PRINCIPAL],
      });
      const debugLines: string[] = [];
      const err = await expectCode(
        connectWith(changed, creds, { verifyHost: verifier, debug: (l) => debugLines.push(l) }),
        'HOST_KEY_MISMATCH',
      );
      expect(err.detail).toBe(
        `expected ${hostEdFp}, received ${hostFingerprint(K('host_ed25519_changed.pub'))}`,
      );
      // Trust was not overwritten and nothing was authenticated.
      expect(store.get(`127.0.0.1:${port}`)?.fingerprintSha256).toBe(hostEdFp);
      expect(debugLines.join('\n')).not.toMatch(/USERAUTH_REQUEST/);
      await new Promise((r) => setTimeout(r, 300));
      expect(changed.log).not.toMatch(/userauth-request/);
    });
  });

  describe('browse and download over a certificate-authenticated session', () => {
    let server: SshdInstance;
    let session: SftpSession;
    beforeAll(async () => {
      server = await startServer('browse', {
        hostKeys: [K('host_ed25519')],
        trustedUserCa: pub(K('ca')),
        principals: [PRINCIPAL],
      });
      session = await connectWith(
        server,
        await loadCredentials({
          privateKeyPath: K('ed_enc'),
          certificatePath: K('ed_enc-cert.pub'),
          passphrase: PASSPHRASE,
        }),
      );
    });
    afterAll(async () => {
      await session?.disconnect();
    });

    it('lists the initial directory with types, sizes and mtimes', async () => {
      const home = await session.realpath('.');
      const entries = await session.list(home);
      const byName = new Map(entries.map((e) => [e.name, e]));
      expect([...byName.keys()].sort()).toEqual(
        [
          '.hidden',
          'dir with space',
          'empty-dir',
          'empty.bin',
          'hello.txt',
          'link-to-dir',
          'no-access',
          'random-8MiB.bin',
        ].sort(),
      );
      expect(byName.get('hello.txt')).toMatchObject({ type: 'file', size: 16 });
      expect(byName.get('empty.bin')).toMatchObject({ type: 'file', size: 0 });
      expect(byName.get('dir with space')?.type).toBe('directory');
      expect(byName.get('link-to-dir')?.type).toBe('symlink');
      expect(typeof byName.get('hello.txt')?.modifiedTime).toBe('number');
      expect((await session.stat(join(home, 'link-to-dir'))).type).toBe('directory');
      expect(await session.list(join(home, 'empty-dir'))).toEqual([]);
      expect((await session.list(join(home, 'dir with space'))).map((e) => e.name)).toEqual([
        'ñandú ☃.txt',
      ]);
    });

    it('distinguishes not-found and permission-denied', async () => {
      const home = await session.realpath('.');
      await expectCode(session.list(join(home, 'does-not-exist')), 'REMOTE_NOT_FOUND');
      await expectCode(session.list(join(home, 'no-access')), 'REMOTE_PERMISSION_DENIED');
    });

    for (const name of ['hello.txt', 'empty.bin', 'random-8MiB.bin']) {
      it(`downloads ${name} by streaming to disk and the SHA-256 matches`, async () => {
        const home = await session.realpath('.');
        const out = join(ROOT, 'downloads', name);
        await mkdir(join(ROOT, 'downloads'), { recursive: true });
        const started = Date.now();
        await pipeline(
          session.createReadStream(join(home, name)),
          createWriteStream(out, { flags: 'wx' }),
        );
        const seconds = (Date.now() - started) / 1000;
        expect(await sha256File(out)).toBe(fileHashes.get(name));
        if (name === 'random-8MiB.bin') {
          // Regression guard for TCP_NODELAY (Nagle stalls gave ~1.4 MiB/s).
          expect(8 / seconds, `throughput ${(8 / seconds).toFixed(1)} MiB/s`).toBeGreaterThan(8);
        }
      });
    }

    it('session reports close after disconnect and rejects further calls', async () => {
      const s = await connectWith(
        server,
        await loadCredentials({ privateKeyPath: K('ed'), certificatePath: K('ed-cert.pub') }),
      );
      let closed = false;
      s.onClose(() => {
        closed = true;
      });
      await s.disconnect();
      expect(closed).toBe(true);
      await expectCode(
        Promise.resolve().then(() => s.list('.')),
        'DISCONNECTED',
      );
    });
  });
});

describe.skipIf(process.env.SFTP_TEST_ALLOW_NO_SSHD === '1')('sshd availability', () => {
  it('a real sshd binary is available (set SFTP_TEST_SSHD if not in /usr/sbin)', () => {
    expect(bin, 'sshd not found: integration tests would be skipped').toBeDefined();
  });
});
