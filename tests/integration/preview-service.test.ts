// PreviewService against a real OpenSSH server on 127.0.0.1 (version 2 image
// preview): real images of every format, a non-image renamed .png, the 20 MiB
// cap (from stat and while streaming), missing / denied / link / folder,
// supersede and cancel, session binding, and a connection killed mid-read.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PreviewService } from '../../src/main/connections/preview-service';
import { PREVIEW_MAX_BYTES } from '../../src/shared/preview';
import { startFixtureServer, signalAll, type FixtureServer } from './helpers/fixture-server';
import { findSshd } from './helpers/sshd';

const bin = findSshd();
const ROOT = resolve(__dirname, '..', '.tmp', `preview-${process.pid}-${Date.now()}`);
const FILES = join(ROOT, 'files');
const IMAGES = resolve(__dirname, '..', 'fixtures', 'images');
const MiB = 1024 ** 2;
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

describe.skipIf(!bin)('PreviewService against real sshd', () => {
  let fx: FixtureServer;
  let sessionId = '';
  let svc: PreviewService;
  const preview = (name: string, requestId = randomUUID()) =>
    svc.preview(sessionId, requestId, join(FILES, name));

  beforeAll(async () => {
    await mkdir(FILES, { recursive: true });
    for (const f of await readdir(IMAGES)) await copyFile(join(IMAGES, f), join(FILES, f));
    await writeFile(
      join(FILES, 'evil.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    await writeFile(join(FILES, 'not-an-image.png'), 'This is a text file renamed to .png\n');
    await writeFile(join(FILES, 'truncated.png'), PNG_SIG);
    // 21 MiB with a PNG signature: refused from stat, before any byte is read.
    await writeFile(join(FILES, 'huge.png'), Buffer.concat([PNG_SIG, randomBytes(21 * MiB)]));
    await writeFile(
      join(FILES, 'exact.png'),
      Buffer.concat([PNG_SIG, randomBytes(PREVIEW_MAX_BYTES - 8)]),
    );
    await writeFile(join(FILES, 'slow.png'), Buffer.concat([PNG_SIG, randomBytes(18 * MiB)]));
    await writeFile(join(FILES, 'denied.png'), await readFile(join(IMAGES, 'sunset.png')));
    await chmod(join(FILES, 'denied.png'), 0o000);
    await symlink('sunset.png', join(FILES, 'link.png'));
    await mkdir(join(FILES, 'folder.png'));
    fx = await startFixtureServer({ bin: bin!, root: join(ROOT, 'srv'), sftpRoot: FILES });
    sessionId = await fx.connect();
    svc = new PreviewService({ getSession: (id) => fx.mgr.getSession(id) });
  }, 60_000);

  afterAll(async () => {
    await chmod(join(FILES, 'denied.png'), 0o644).catch(() => undefined);
    await fx?.stop();
    if (!process.env.KEEP_TEST_TMP) await rm(ROOT, { recursive: true, force: true });
  });

  it.each([
    ['sunset.png', 'image/png'],
    ['night.jpg', 'image/jpeg'],
    ['blink.gif', 'image/gif'],
    ['meadow.webp', 'image/webp'],
    ['tiles.bmp', 'image/bmp'],
    ['favicon.ico', 'image/x-icon'],
    ['dusk.avif', 'image/avif'],
    ['evil.svg', 'image/svg+xml'],
  ])('%s: exact bytes, detected as %s', async (name, mime) => {
    const want = await readFile(join(FILES, name));
    const r = await preview(name);
    expect(r.mime).toBe(mime);
    expect(r.size).toBe(want.length);
    expect(sha(r.bytes)).toBe(sha(want));
    expect(r.path).toBe(join(FILES, name));
  });

  it('a file of exactly 20 MiB is allowed', async () => {
    expect((await preview('exact.png')).size).toBe(PREVIEW_MAX_BYTES);
  });

  it.each([
    ['not-an-image.png', 'PREVIEW_UNSUPPORTED'],
    ['truncated.png', 'OK'],
    ['huge.png', 'PREVIEW_TOO_LARGE'],
    ['missing.png', 'REMOTE_NOT_FOUND'],
    ['denied.png', 'REMOTE_PERMISSION_DENIED'],
    ['link.png', 'PREVIEW_NOT_A_FILE'],
    ['folder.png', 'PREVIEW_NOT_A_FILE'],
  ])('%s → %s', async (name, want) => {
    expect(await code(preview(name))).toBe(want);
  });

  it('the cap is enforced while streaming when the file grows after stat', async () => {
    await writeFile(join(FILES, 'grows.png'), Buffer.concat([PNG_SIG, randomBytes(MiB / 2)]));
    const growing = new PreviewService({
      getSession: (id) => fx.mgr.getSession(id),
      maxBytes: MiB,
      afterStat: (p) => appendFile(p, randomBytes(2 * MiB)),
    });
    expect(await code(growing.preview(sessionId, randomUUID(), join(FILES, 'grows.png')))).toBe(
      'PREVIEW_TOO_LARGE',
    );
  });

  it('a newer request supersedes a slow one; cancel ends a read; old ids are stale', async () => {
    const first = randomUUID();
    const slow = code(preview('slow.png', first));
    const fast = preview('sunset.png');
    expect(await slow).toBe('CANCELLED');
    expect((await fast).mime).toBe('image/png');
    const id = randomUUID();
    const p = code(preview('slow.png', id));
    expect(svc.cancel(sessionId, id)).toBe(true);
    expect(await p).toBe('CANCELLED');
    expect(svc.cancel(sessionId, first)).toBe(false);
  });

  it('only the current session: unknown ids are refused', async () => {
    expect(await code(svc.preview(randomUUID(), randomUUID(), join(FILES, 'sunset.png')))).toBe(
      'DISCONNECTED',
    );
  });

  it('connection killed mid-preview: DISCONNECTED, and the old session id stays refused', async () => {
    const pids = fx.sessionPids();
    signalAll(pids, 'SIGSTOP');
    const p = code(preview('slow.png'));
    await new Promise((r) => setTimeout(r, 300));
    signalAll(pids, 'SIGKILL');
    expect(await p).toBe('DISCONNECTED');
    const old = sessionId;
    sessionId = await fx.connect();
    expect(await code(svc.preview(old, randomUUID(), join(FILES, 'sunset.png')))).toBe(
      'DISCONNECTED',
    );
    expect((await preview('sunset.png')).mime).toBe('image/png');
  }, 30_000);
});
