import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PreviewCache,
  thumbnailCacheKey,
  type CachedThumbnail,
} from '../../src/main/platform/preview-cache';
import { useTempDir } from './helpers';

const png = (n: number, fill = 7): CachedThumbnail => ({
  mime: 'image/png',
  bytes: new Uint8Array(n).fill(fill),
});

const key = (over: Partial<Parameters<typeof thumbnailCacheKey>[0]> = {}): string =>
  thumbnailCacheKey({
    profileId: 'profile-a',
    hostFingerprint: 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    remotePath: '/srv/photos/sunset.png',
    size: 'small',
    modifiedTime: 1_700_000_000,
    fileSize: 100,
    ...over,
  });

describe('thumbnail cache key', () => {
  it('is 64 hex chars and changes with identity, path, size, mtime and byte size', () => {
    const base = key();
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(key()).toBe(base);
    for (const over of [
      { profileId: 'profile-b' },
      { hostFingerprint: 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      { remotePath: '/srv/photos/other.png' },
      { remotePath: '/tmp/../../etc/passwd' },
      { size: 'large' as const },
      { modifiedTime: 1_700_000_001 },
      { modifiedTime: null },
      { fileSize: 101 },
      { fileSize: null },
    ]) {
      expect(key(over)).not.toBe(base);
    }
  });
});

describe('PreviewCache', () => {
  const tmp = useTempDir();

  it('misses, then hits from memory and from a fresh instance on disk', async () => {
    const dir = join(await tmp(), 'preview-cache');
    const cache = new PreviewCache(dir);
    const id = key();
    expect(await cache.get(id)).toBeNull();
    expect(cache.hits.miss).toBe(1);
    await cache.put(id, png(8, 9));
    const mem = await cache.get(id);
    expect(mem).toEqual(png(8, 9));
    expect(cache.hits.memory).toBe(1);
    expect(mem?.bytes.buffer.byteLength).toBe(8);

    const again = new PreviewCache(dir);
    expect(again.memoryHas(id)).toBe(false);
    expect(await again.get(id)).toEqual(png(8, 9));
    expect(again.hits.disk).toBe(1);
    expect(await again.files()).toEqual([id]);
  });

  it('does not store the remote path, and rejects a key that is not hex', async () => {
    const dir = join(await tmp(), 'preview-cache');
    const cache = new PreviewCache(dir);
    const secret = '/home/me/.ssh/id_ed25519 BEGIN OPENSSH PRIVATE KEY passphrase';
    const id = key({ remotePath: secret });
    await cache.put(id, png(4, 3));
    const names = await cache.files();
    expect(names).toEqual([id]);
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(join(dir, id));
    expect(body.includes(Buffer.from(secret))).toBe(false);
    expect(body.includes(Buffer.from('OPENSSH'))).toBe(false);
    expect(body.includes(Buffer.from('passphrase'))).toBe(false);
    await expect(cache.put('../passwd', png(1))).rejects.toThrow(/hex/);
    await expect(cache.get('..')).rejects.toThrow(/hex/);
    await expect(cache.get(`${id}/../passwd`)).rejects.toThrow(/hex/);
  });

  it('evicts the least recently used file past the disk cap, and the memory LRU', async () => {
    const dir = join(await tmp(), 'preview-cache');
    const disk = new PreviewCache(dir, 200, 10_000_000);
    const ids = [key({ fileSize: 1 }), key({ fileSize: 2 }), key({ fileSize: 3 })];
    for (const id of ids) {
      await disk.put(id, png(80));
      await new Promise((r) => setTimeout(r, 25));
    }
    const left = await disk.files();
    expect(left).toEqual([ids[2]]);
    expect(await disk.diskBytes()).toBeLessThanOrEqual(200);
    expect(await disk.get(ids[0]!)).toBeNull();
    expect(await disk.get(ids[2]!)).toEqual(png(80));

    const memDir = join(await tmp(), 'mem');
    const mem = new PreviewCache(memDir, 10_000_000, 100);
    const mids = [
      key({ profileId: 'm', fileSize: 1 }),
      key({ profileId: 'm', fileSize: 2 }),
      key({ profileId: 'm', fileSize: 3 }),
    ];
    for (const id of mids) await mem.put(id, png(40));
    expect(mem.memoryBytes()).toBeLessThanOrEqual(100);
    expect(mem.memoryHas(mids[0]!)).toBe(false);
    expect(mem.memoryHas(mids[2]!)).toBe(true);
    expect((await mem.get(mids[0]!))?.mime).toBe('image/png');
    expect(mem.hits.disk).toBe(1);
    expect((await mem.get(mids[2]!)) && mem.hits.memory).toBe(1);
  });

  it('a symlink in the cache is not followed or deleted at its target, and junk names are removed', async () => {
    const root = await tmp();
    const dir = join(root, 'preview-cache');
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'TOP-SECRET-MARKER');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const id = key();
    await symlink(secret, join(dir, id));
    await writeFile(join(dir, 'evil.txt'), 'nope');
    const cache = new PreviewCache(dir);
    expect(await cache.get(id)).toBeNull();
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(secret, 'utf8')).toBe('TOP-SECRET-MARKER');
    await cache.put(id, png(3, 4));
    expect(await readFile(secret, 'utf8')).toBe('TOP-SECRET-MARKER');
    expect(await cache.files()).toEqual([id]);
    expect(await cache.get(id)).toEqual(png(3, 4));
    await expect(readFile(join(dir, 'evil.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clear removes files and memory', async () => {
    const dir = join(await tmp(), 'preview-cache');
    const cache = new PreviewCache(dir);
    const id = key();
    await cache.put(id, png(5));
    await cache.clear();
    expect(cache.memoryBytes()).toBe(0);
    expect(await cache.files()).toEqual([]);
    expect(await cache.get(id)).toBeNull();
  });

  it('a negative entry round-trips as no thumbnail', async () => {
    const dir = join(await tmp(), 'preview-cache');
    const cache = new PreviewCache(dir);
    const id = key();
    await cache.put(id, { mime: null, bytes: new Uint8Array(0) });
    expect(await cache.get(id)).toEqual({ mime: null, bytes: new Uint8Array(0) });
  });
});
