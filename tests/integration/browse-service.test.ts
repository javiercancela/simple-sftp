// BrowseService against a real OpenSSH server on 127.0.0.1: listing metadata,
// symlink targets, error classification, superseded/cancelled requests,
// session ownership, and a 10,000-entry directory. No mocks.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowseService } from '../../src/main/connections/browse-service';
import { ConnectionManager } from '../../src/main/connections/connection-manager';
import { TrustStore } from '../../src/main/connections/trust-store';
import type { Listing } from '../../src/shared/browse';
import type { Profile } from '../../src/shared/profiles';
import { hostFingerprint, keygen, pub, signCert } from './helpers/keys';
import { SshdInstance, findSshd, freePort } from './helpers/sshd';

const bin = findSshd();
const ROOT = resolve(__dirname, '..', '.tmp', `browse-${process.pid}-${Date.now()}`);
const FILES = join(ROOT, 'files');
const K = (n: string): string => join(ROOT, 'keys', n);
const PRINCIPAL = 'sftp-test-principal';

let server: SshdInstance;
let mgr: ConnectionManager;
let browse: BrowseService;
let sessionId = '';

function descendants(pid: number): number[] {
  const rows = execFileSync('ps', ['-e', '-o', 'pid=,ppid='])
    .toString()
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const out: number[] = [];
  const walk = (p: number): void => {
    for (const [c, pp] of rows) {
      if (pp !== p) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(pid);
  return out;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

const list = (path: string, requestId = randomUUID()): Promise<Listing> =>
  browse.list(sessionId, requestId, path);

describe.skipIf(!bin)('BrowseService against real sshd', () => {
  beforeAll(async () => {
    await mkdir(join(ROOT, 'keys'), { recursive: true });
    await mkdir(join(FILES, 'nested', 'a', 'b'), { recursive: true });
    await writeFile(join(FILES, 'nested', 'a', 'b', 'deep.txt'), 'deep');
    await mkdir(join(FILES, 'empty dir'));
    await mkdir(join(FILES, '.hidden-dir'));
    await writeFile(join(FILES, '.hidden-file'), 'h');
    await writeFile(join(FILES, 'Ünïcødé ファイル.txt'), 'u');
    await writeFile(join(FILES, 'name with spaces.txt'), 'abc');
    await writeFile(join(FILES, 'zero.bin'), '');
    await writeFile(join(FILES, 'line\nbreak.txt'), 'x');
    await writeFile(join(FILES, '<img src=x onerror=alert(1)>.txt'), 'x');
    await utimes(join(FILES, 'name with spaces.txt'), 1_700_000_000, 1_700_000_000);
    await mkdir(join(FILES, 'no-access'));
    await writeFile(join(FILES, 'no-access', 'secret.txt'), 's');
    await chmod(join(FILES, 'no-access'), 0o000);
    await symlink(join(FILES, 'nested'), join(FILES, 'link-to-nested'));
    await symlink('name with spaces.txt', join(FILES, 'link-to-file'));
    await symlink('does-not-exist', join(FILES, 'broken-link'));
    await mkdir(join(FILES, 'big'));
    await Promise.all(
      Array.from({ length: 10_000 }, (_, i) =>
        writeFile(join(FILES, 'big', `file-${String(i).padStart(5, '0')}.dat`), ''),
      ),
    );

    keygen(K('host'), 'ed25519');
    keygen(K('ca'), 'ed25519');
    keygen(K('ed'), 'ed25519');
    signCert({ caPath: K('ca'), keyPath: K('ed'), principals: [PRINCIPAL], validity: '-5m:+1h' });
    server = new SshdInstance(bin!, {
      dir: join(ROOT, 'server'),
      port: await freePort(),
      hostKeys: [K('host')],
      sftpRoot: FILES,
      trustedUserCa: pub(K('ca')),
      principals: [PRINCIPAL],
    });
    await server.start();

    const profile: Profile = {
      id: randomUUID(),
      createdAt: '',
      updatedAt: '',
      name: 'browse',
      host: '127.0.0.1',
      port: server.cfg.port,
      username: userInfo().username,
      authMode: 'privateKeyAndCertificate',
      privateKeyPath: K('ed'),
      certificatePath: K('ed-cert.pub'),
      initialRemoteDirectory: null,
      downloadDirectory: null,
    };
    await mkdir(join(ROOT, 'state'), { recursive: true });
    const trust = new TrustStore(join(ROOT, 'state'));
    await trust.load();
    await trust.trust({
      host: '127.0.0.1',
      port: server.cfg.port,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: hostFingerprint(K('host.pub')),
    });
    let resolveReady: () => void;
    const ready = new Promise<void>((r) => (resolveReady = r));
    mgr = new ConnectionManager({
      getProfile: (id) => (id === profile.id ? profile : undefined),
      trust,
      emit: (s) => s.state === 'connected' && resolveReady(),
    });
    browse = new BrowseService({ getSession: (id) => mgr.getSession(id) });
    sessionId = await mgr.connect(profile.id);
    await ready;
  }, 180_000);

  afterAll(async () => {
    await mgr?.shutdown();
    await server?.stop();
    await chmod(join(FILES, 'no-access'), 0o755).catch(() => undefined);
    if (!process.env.KEEP_TEST_TMP) await rm(ROOT, { recursive: true, force: true });
  });

  it('lists names, types, sizes and times; unicode, spaces, hidden, control chars and markup are plain data', async () => {
    const r = await list(FILES);
    expect(r.path).toBe(FILES);
    const by = new Map(r.entries.map((e) => [e.name, e]));
    expect([...by.keys()].sort()).toEqual(
      [
        '.hidden-dir',
        '.hidden-file',
        '<img src=x onerror=alert(1)>.txt',
        'big',
        'broken-link',
        'empty dir',
        'line\nbreak.txt',
        'link-to-file',
        'link-to-nested',
        'name with spaces.txt',
        'nested',
        'no-access',
        'zero.bin',
        'Ünïcødé ファイル.txt',
      ].sort(),
    );
    expect(by.get('name with spaces.txt')).toMatchObject({
      type: 'file',
      size: 3,
      modifiedTime: 1_700_000_000,
      safeName: true,
    });
    expect(by.get('zero.bin')).toMatchObject({ type: 'file', size: 0 });
    expect(by.get('nested')).toMatchObject({ type: 'directory', size: null });
    expect(by.get('link-to-nested')).toMatchObject({ type: 'symlink', linkTarget: 'directory' });
    expect(by.get('link-to-file')).toMatchObject({ type: 'symlink', linkTarget: 'file' });
    expect(by.get('broken-link')).toMatchObject({ type: 'symlink', linkTarget: 'broken' });
  });

  it('navigates nested folders, through a symlink to a folder, and normalizes paths', async () => {
    expect((await list(join(FILES, 'nested/a/b'))).entries.map((e) => e.name)).toEqual([
      'deep.txt',
    ]);
    const viaLink = await list(`${FILES}/link-to-nested/a/`);
    expect(viaLink.path).toBe(`${FILES}/link-to-nested/a`); // the path you navigated, not the target
    expect(viaLink.entries.map((e) => e.name)).toEqual(['b']);
    expect((await list(`${FILES}/nested/a/b/../..//`)).path).toBe(`${FILES}/nested`);
    expect((await list(join(FILES, 'empty dir'))).entries).toEqual([]);
  });

  it('classifies permission denied, not found and not-a-folder', async () => {
    expect(await codeOf(list(join(FILES, 'no-access')))).toBe('REMOTE_PERMISSION_DENIED');
    expect(await codeOf(list(join(FILES, 'missing')))).toBe('REMOTE_NOT_FOUND');
    const notDir = await codeOf(list(join(FILES, 'zero.bin')));
    expect(['REMOTE_NOT_FOUND', 'REMOTE_ERROR']).toContain(notDir);
  });

  it('lists a 10,000-entry folder', async () => {
    const t0 = performance.now();
    const r = await list(join(FILES, 'big'));
    const ms = performance.now() - t0;
    console.log(`[browse] 10,000-entry listing over SFTP: ${ms.toFixed(0)} ms`);
    expect(r.entries).toHaveLength(10_000);
    expect(ms).toBeLessThan(10_000);
  });

  it('a superseded request never resolves with data; the newest one does', async () => {
    const frozen = descendants(server.pid!);
    for (const p of frozen) process.kill(p, 'SIGSTOP');
    const first = list(join(FILES, 'nested'));
    const second = list(join(FILES, 'empty dir'));
    await new Promise((r) => setTimeout(r, 300));
    for (const p of frozen) process.kill(p, 'SIGCONT');
    expect(await codeOf(first)).toBe('CANCELLED');
    expect((await second).path).toBe(join(FILES, 'empty dir'));
  });

  it('a cancelled request resolves CANCELLED even when the server answers later', async () => {
    const frozen = descendants(server.pid!);
    for (const p of frozen) process.kill(p, 'SIGSTOP');
    const id = randomUUID();
    const pending = list(join(FILES, 'nested'), id);
    expect(browse.cancel(sessionId, id)).toBe(true);
    expect(browse.cancel(sessionId, id)).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    for (const p of frozen) process.kill(p, 'SIGCONT');
    expect(await codeOf(pending)).toBe('CANCELLED');
  });

  it('requests for another or unknown session are refused', async () => {
    expect(await codeOf(browse.list(randomUUID(), randomUUID(), '/'))).toBe('DISCONNECTED');
  });

  it('the session the browser uses exposes only read operations', () => {
    const s = mgr.getSession(sessionId)!;
    const methods = new Set<string>();
    for (
      let o = Object.getPrototypeOf(s);
      o && o !== Object.prototype;
      o = Object.getPrototypeOf(o)
    )
      for (const k of Object.getOwnPropertyNames(o))
        if (k !== 'constructor' && typeof (s as never)[k] === 'function') methods.add(k);
    const writeLike = [...methods].filter((m) =>
      /write|put|mkdir|rmdir|unlink|rename|remove|delete|exec|shell|chmod|chown|symlink|setstat/i.test(
        m,
      ),
    );
    expect(writeLike).toEqual([]);
  });

  it('disconnect from an unresponsive server during a listing finishes; the request fails, never hangs', async () => {
    const frozen = descendants(server.pid!);
    for (const p of frozen) process.kill(p, 'SIGSTOP');
    const pending = list(join(FILES, 'nested'));
    const t0 = Date.now();
    // The server is frozen: disconnect must still finish (hard stop after 3 s)
    // and the in-flight request must fail rather than hang.
    await mgr.shutdown();
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(['DISCONNECTED', 'CONNECTION_LOST', 'CANCELLED']).toContain(await codeOf(pending));
    for (const p of frozen) process.kill(p, 'SIGCONT');
    expect(await codeOf(list('/'))).toBe('DISCONNECTED');
  });
});
