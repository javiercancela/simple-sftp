import { Readable } from 'node:stream';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransportError } from '../../src/main/connections/errors';
import {
  ThumbnailService,
  type ThumbnailEncoder,
  type ThumbnailIdentity,
} from '../../src/main/connections/thumbnail-service';
import type { SftpSession } from '../../src/main/connections/transport';
import { PreviewCache } from '../../src/main/platform/preview-cache';
import { THUMBNAIL_MAX_EDGE } from '../../src/shared/preview';
import type { PreviewSize } from '../../src/shared/settings';
import type { RemoteStat } from '../../src/shared/transport-contract';
import { useTempDir } from './helpers';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SID = 'session-1';

function fakeSession(opts: {
  stat?: Partial<RemoteStat> | (() => Partial<RemoteStat>);
  chunks?: Uint8Array[];
  hang?: boolean;
}): SftpSession & { reads: number; close(): void } {
  const closers = new Set<(e: TransportError | undefined) => void>();
  const s = {
    reads: 0,
    hostKey: {
      host: '127.0.0.1',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: `SHA256:${'A'.repeat(43)}`,
    },
    list: () => Promise.reject(new Error('no')),
    stat: () => Promise.reject(new Error('no')),
    realpath: () => Promise.reject(new Error('no')),
    lstat: () => {
      const extra = typeof opts.stat === 'function' ? opts.stat() : opts.stat;
      return Promise.resolve({
        type: 'file' as const,
        size: PNG.byteLength,
        modifiedTime: 10,
        ...extra,
      });
    },
    createReadStream: () => {
      s.reads++;
      const list = [...(opts.chunks ?? [PNG])];
      return new Readable({
        read() {
          const c = list.shift();
          if (c) this.push(Buffer.from(c));
          else if (!opts.hang) this.push(null);
        },
      });
    },
    disconnect: () => Promise.resolve(),
    onClose: (l: (e: TransportError | undefined) => void) => {
      closers.add(l);
      return () => closers.delete(l);
    },
    close: () => {
      for (const l of [...closers]) l(undefined);
    },
  };
  return s;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

function setup(
  dir: string,
  session: SftpSession | null,
  opts?: { maxBytes?: number; maxConcurrent?: number },
) {
  const cache = new PreviewCache(join(dir, 'preview-cache'));
  let identity: ThumbnailIdentity | null = {
    profileId: 'profile-a',
    hostFingerprint: 'fp-server-a',
  };
  const edges: number[] = [];
  const encode: ThumbnailEncoder = async (bytes, _mime, edge) => {
    edges.push(edge);
    const out = new Uint8Array(4);
    out.set(bytes.subarray(0, 3));
    out[3] = edge & 0xff;
    return { mime: 'image/png', bytes: out };
  };
  const svc = new ThumbnailService({
    getSession: () => session,
    getIdentity: () => identity,
    cache,
    encode,
    ...(opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts?.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
  });
  return {
    cache,
    svc,
    edges,
    setIdentity: (id: ThumbnailIdentity | null) => {
      identity = id;
    },
  };
}

describe('ThumbnailService', () => {
  const tmp = useTempDir();

  it('misses then hits, isolates servers, and invalidates on mtime; stores the thumbnail not the file', async () => {
    const dir = await tmp();
    let mtime = 10;
    const session = fakeSession({
      stat: () => ({ modifiedTime: mtime, size: 4000 }),
      chunks: [PNG, new Uint8Array(4000).fill(0x41)],
    });
    const { svc, cache, edges, setIdentity } = setup(dir, session);
    const secret = '/secret-passphrase-folder/id_ed25519.png';
    const first = await svc.thumbnail(SID, 'r1', `/a/../${secret.slice(1)}`, 'small');
    expect(first.mime).toBe('image/png');
    expect(first.path).toBe(secret);
    expect(first.bytes.byteLength).toBe(4);
    expect(session.reads).toBe(1);
    expect(edges).toEqual([THUMBNAIL_MAX_EDGE.small]);

    const second = await svc.thumbnail(SID, 'r2', secret, 'small');
    expect(second.bytes).toEqual(first.bytes);
    expect(session.reads).toBe(1);

    const large = await svc.thumbnail(SID, 'r3', secret, 'large');
    expect(large.mime).toBe('image/png');
    expect(session.reads).toBe(2);
    expect(edges).toEqual([THUMBNAIL_MAX_EDGE.small, THUMBNAIL_MAX_EDGE.large]);

    setIdentity({ profileId: 'profile-a', hostFingerprint: 'fp-server-b' });
    await svc.thumbnail(SID, 'r4', secret, 'small');
    expect(session.reads).toBe(3);
    setIdentity({ profileId: 'profile-b', hostFingerprint: 'fp-server-a' });
    await svc.thumbnail(SID, 'r5', secret, 'small');
    expect(session.reads).toBe(4);
    setIdentity({ profileId: 'profile-a', hostFingerprint: 'fp-server-a' });
    await svc.thumbnail(SID, 'r6', secret, 'small');
    expect(session.reads).toBe(4);

    mtime = 11;
    await svc.thumbnail(SID, 'r7', secret, 'small');
    expect(session.reads).toBe(5);

    const { readFile } = await import('node:fs/promises');
    for (const name of await cache.files()) {
      const body = await readFile(join(dir, 'preview-cache', name));
      expect(body.includes(Buffer.from('secret-passphrase'))).toBe(false);
      expect(body.includes(Buffer.from('id_ed25519'))).toBe(false);
      expect(body.length).toBeLessThan(32);
    }
  });

  it('caches a non-image and an over-cap file without reading them again', async () => {
    const dir = await tmp();
    const text = fakeSession({ chunks: [Uint8Array.from(Buffer.from('hello not an image'))] });
    const { svc } = setup(dir, text);
    const a = await svc.thumbnail(SID, 'r1', '/fake.png', 'small');
    expect(a.mime).toBeNull();
    expect(text.reads).toBe(1);
    await svc.thumbnail(SID, 'r2', '/fake.png', 'small');
    expect(text.reads).toBe(1);

    const big = fakeSession({ stat: { size: 9_999 } });
    const capped = setup(await tmp(), big, { maxBytes: 100 }).svc;
    const b = await capped.thumbnail(SID, 'r', '/big.png', 'large');
    expect(b.mime).toBeNull();
    expect(big.reads).toBe(0);
    await capped.thumbnail(SID, 'r2', '/big.png', 'large');
    expect(big.reads).toBe(0);
  });

  it('a file that grows past the cap while streaming is not read again', async () => {
    const dir = await tmp();
    const chunk = new Uint8Array(50);
    chunk.set(PNG);
    const session = fakeSession({ stat: { size: 10 }, chunks: [chunk] });
    const { svc } = setup(dir, session, { maxBytes: 20 });
    const r = await svc.thumbnail(SID, 'r', '/grows.png', 'small');
    expect(r.mime).toBeNull();
    expect(session.reads).toBe(1);
    await svc.thumbnail(SID, 'r2', '/grows.png', 'small');
    expect(session.reads).toBe(1);
  });

  it('refuses folders, and a closed session is disconnected', async () => {
    const dir = await tmp();
    const session = fakeSession({ stat: { type: 'directory' } });
    const { svc } = setup(dir, session);
    expect(await code(svc.thumbnail(SID, 'r', '/dir.png', 'small'))).toBe('PREVIEW_NOT_A_FILE');
    expect(session.reads).toBe(0);
    expect(
      await code(
        new ThumbnailService({
          getSession: () => null,
          getIdentity: () => ({ profileId: 'p', hostFingerprint: 'f' }),
          cache: new PreviewCache(join(dir, 'other')),
          encode: async () => null,
        }).thumbnail(SID, 'r', '/a.png', 'small'),
      ),
    ).toBe('DISCONNECTED');

    const hung = fakeSession({ hang: true });
    const live = setup(await tmp(), hung).svc;
    const p = code(live.thumbnail(SID, 'r', '/a.png', 'small'));
    await waitFor(() => hung.reads === 1);
    hung.close();
    expect(await p).toBe('DISCONNECTED');
  });

  it('limits concurrent reads and does not read a request cancelled while waiting', async () => {
    const dir = await tmp();
    const session = fakeSession({ hang: true });
    const { svc } = setup(dir, session, { maxConcurrent: 2 });
    const a = code(svc.thumbnail(SID, 'a', '/a.png', 'small'));
    const b = code(svc.thumbnail(SID, 'b', '/b.png', 'small'));
    const c = code(svc.thumbnail(SID, 'c', '/c.png', 'small'));
    await waitFor(() => session.reads === 2);
    expect(svc.cancel(SID, 'c')).toBe(true);
    expect(await c).toBe('CANCELLED');
    expect(session.reads).toBe(2);
    expect(svc.cancel(SID, 'a')).toBe(true);
    expect(svc.cancel(SID, 'b')).toBe(true);
    expect(svc.cancel(SID, 'nope')).toBe(false);
    expect(await a).toBe('CANCELLED');
    expect(await b).toBe('CANCELLED');

    // A slot freed by cancel lets the next queued read start.
    const d = code(svc.thumbnail(SID, 'd', '/d.png', 'small'));
    const e = code(svc.thumbnail(SID, 'e', '/e.png', 'small'));
    const f = code(svc.thumbnail(SID, 'f', '/f.png', 'small'));
    await waitFor(() => session.reads === 4);
    expect(svc.cancel(SID, 'd')).toBe(true);
    await waitFor(() => session.reads === 5);
    expect(await d).toBe('CANCELLED');
    expect(svc.cancel(SID, 'e')).toBe(true);
    expect(svc.cancel(SID, 'f')).toBe(true);
    expect(await e).toBe('CANCELLED');
    expect(await f).toBe('CANCELLED');
  });

  it('clear drops the cache, and an in-flight encode does not write it back', async () => {
    const dir = await tmp();
    const session = fakeSession({});
    const started: Array<() => void> = [];
    const cache = new PreviewCache(join(dir, 'preview-cache'));
    let hold = true;
    const encode: ThumbnailEncoder = () =>
      new Promise((resolve) => {
        const finish = (): void =>
          resolve({ mime: 'image/png', bytes: Uint8Array.from([1, 2, 3, 4]) });
        if (hold) started.push(finish);
        else finish();
      });
    const svc = new ThumbnailService({
      getSession: () => session,
      getIdentity: () => ({ profileId: 'p', hostFingerprint: 'f' }),
      cache,
      encode,
    });
    const pending = svc.thumbnail(SID, 'r', '/a.png', 'small');
    await waitFor(() => started.length === 1);
    const cleared = svc.clearCache();
    hold = false;
    started[0]!();
    const done = await pending;
    await cleared;
    expect(done.mime).toBe('image/png');
    expect(await cache.files()).toEqual([]);
    await svc.thumbnail(SID, 'r2', '/a.png', 'small');
    expect(session.reads).toBe(2);
    expect(await cache.files()).toHaveLength(1);
    await svc.clearCache();
    expect(await cache.files()).toEqual([]);
  });

  it('sizes are part of the request', () => {
    const sizes: PreviewSize[] = ['small', 'large'];
    expect(new Set(sizes.map((s) => THUMBNAIL_MAX_EDGE[s])).size).toBe(2);
  });
});
