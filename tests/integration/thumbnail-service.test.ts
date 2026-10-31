// ThumbnailService against a real OpenSSH server on 127.0.0.1: a real image
// is read once and then served from disk, a changed mtime misses, another
// host fingerprint cannot see the entry, and a file over the cap is not read.
import { readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ThumbnailService } from '../../src/main/connections/thumbnail-service';
import type { SftpSession } from '../../src/main/connections/transport';
import { PreviewCache } from '../../src/main/platform/preview-cache';
import { startFixtureServer, type FixtureServer } from './helpers/fixture-server';
import { findSshd } from './helpers/sshd';

const bin = findSshd();
const ROOT = resolve(__dirname, '..', '.tmp', `thumbs-${process.pid}-${Date.now()}`);
const FILES = join(ROOT, 'files');
const IMAGES = resolve(__dirname, '..', 'fixtures', 'images');

describe.skipIf(!bin)('ThumbnailService against real sshd', () => {
  let fx: FixtureServer;
  let sessionId = '';
  let reads = 0;
  let fingerprint = 'server-a';
  let svc: ThumbnailService;
  const cache = () => new PreviewCache(join(ROOT, 'preview-cache'));
  let store: PreviewCache;

  // One wrapper per live session: the service treats a different object as a
  // disconnect, and getSession is called more than once per thumbnail.
  let raw: SftpSession | null = null;
  let wrapped: SftpSession | null = null;
  function watch(id: string): SftpSession | null {
    const session = fx.mgr.getSession(id);
    if (!session) return null;
    if (session !== raw || !wrapped) {
      raw = session;
      wrapped = {
        hostKey: session.hostKey,
        list: (p) => session.list(p),
        stat: (p) => session.stat(p),
        lstat: (p) => session.lstat(p),
        realpath: (p) => session.realpath(p),
        createReadStream: (p, o) => {
          reads++;
          return session.createReadStream(p, o);
        },
        disconnect: () => session.disconnect(),
        onClose: (l) => session.onClose(l),
      };
    }
    return wrapped;
  }

  beforeAll(async () => {
    const { mkdir, copyFile } = await import('node:fs/promises');
    await mkdir(FILES, { recursive: true });
    await copyFile(join(IMAGES, 'sunset.png'), join(FILES, 'sunset.png'));
    await writeFile(join(FILES, 'notes.txt'), 'not an image\n');
    await writeFile(join(FILES, 'big.png'), Buffer.alloc(2 * 1024 * 1024, 1));
    fx = await startFixtureServer({ bin: bin!, root: join(ROOT, 'srv'), sftpRoot: FILES });
    sessionId = await fx.connect();
    store = cache();
    svc = new ThumbnailService({
      getSession: watch,
      getIdentity: () => ({ profileId: fx.profile.id, hostFingerprint: fingerprint }),
      cache: store,
      // Stand-in for Electron's resizer: proves we cache this, not the file.
      encode: async (bytes, _mime, edge) => ({
        mime: 'image/png',
        bytes: Uint8Array.from([edge & 0xff, bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0]),
      }),
      maxBytes: 1024 * 1024,
    });
  }, 60_000);

  afterAll(async () => {
    await fx?.stop();
    const { rm } = await import('node:fs/promises');
    if (!process.env.KEEP_TEST_TMP) await rm(ROOT, { recursive: true, force: true });
  });

  const sunset = (): string => join(FILES, 'sunset.png');

  it('reads a real image once, then hits memory and disk', async () => {
    const first = await svc.thumbnail(sessionId, 'a', sunset(), 'small');
    expect(first.mime).toBe('image/png');
    expect(first.bytes[0]).toBe(160 & 0xff);
    expect(reads).toBe(1);
    await svc.thumbnail(sessionId, 'b', sunset(), 'small');
    expect(reads).toBe(1);

    const disk = new ThumbnailService({
      getSession: watch,
      getIdentity: () => ({ profileId: fx.profile.id, hostFingerprint: fingerprint }),
      cache: new PreviewCache(join(ROOT, 'preview-cache')),
      encode: async () => {
        throw new Error('encode should not run on a disk hit');
      },
      maxBytes: 1024 * 1024,
    });
    const again = await disk.thumbnail(sessionId, 'c', sunset(), 'small');
    expect(again.bytes).toEqual(first.bytes);
    expect(reads).toBe(1);
  });

  it('a new mtime misses; another server fingerprint cannot use the entry', async () => {
    const before = reads;
    await utimes(join(FILES, 'sunset.png'), 1_700_000_000, 1_700_000_000);
    await svc.thumbnail(sessionId, 'd', sunset(), 'small');
    expect(reads).toBe(before + 1);
    fingerprint = 'server-b';
    await svc.thumbnail(sessionId, 'e', sunset(), 'small');
    expect(reads).toBe(before + 2);
    fingerprint = 'server-a';
    await svc.thumbnail(sessionId, 'f', sunset(), 'small');
    expect(reads).toBe(before + 2);
  });

  it('a file over the cap is not read, and cache files are hex names with no remote path', async () => {
    const before = reads;
    const big = await svc.thumbnail(sessionId, 'g', join(FILES, 'big.png'), 'large');
    expect(big.mime).toBeNull();
    expect(reads).toBe(before);
    await svc.thumbnail(sessionId, 'h', join(FILES, 'big.png'), 'large');
    expect(reads).toBe(before);
    const names = await readdir(join(ROOT, 'preview-cache'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toMatch(/^[a-f0-9]{64}$/);
      const body = await readFile(join(ROOT, 'preview-cache', name));
      expect(body.includes(Buffer.from('sunset.png'))).toBe(false);
      expect(body.includes(Buffer.from(fx.profile.privateKeyPath))).toBe(false);
    }
  });
});
