// On-disk and in-memory cache of grid thumbnails (version 2, outside SPEC.md).
//
// A file is named by the SHA-256 of (profile id, host-key fingerprint,
// normalized remote path, size variant, mtime, byte size). The remote path is
// never a filesystem path, so a hostile name cannot escape this directory.
// The fingerprint is taken from the live session in main; a lookup for another
// server hashes differently and cannot read this server's bytes.
//
// Nothing here is a credential: the payload is a downsized PNG, a small SVG,
// or a one-byte "no thumbnail" marker. Files are mode 0600 under the app's
// user-data directory.
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { PREVIEW_MIMES, type PreviewMime } from '../../shared/preview';
import type { PreviewSize } from '../../shared/settings';

export const PREVIEW_CACHE_MAX_DISK_BYTES = 128 * 1024 * 1024;
export const PREVIEW_CACHE_MAX_MEMORY_BYTES = 32 * 1024 * 1024;

const KEY = /^[a-f0-9]{64}$/;
const ALLOWED_MIME = new Set<string>(PREVIEW_MIMES);

export interface CachedThumbnail {
  /** Null means the tile should show an icon, not an image. */
  mime: PreviewMime | null;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface ThumbnailCacheKeyInput {
  profileId: string;
  /** Host-key fingerprint from the live session, never from the renderer. */
  hostFingerprint: string;
  remotePath: string;
  size: PreviewSize;
  modifiedTime: number | null;
  fileSize: number | null;
}

/** Stable id for one thumbnail. A change of path, size, mtime or size misses. */
export function thumbnailCacheKey(input: ThumbnailCacheKeyInput): string {
  const h = createHash('sha256');
  h.update('thumb-v1');
  h.update('\0');
  h.update(input.profileId);
  h.update('\0');
  h.update(input.hostFingerprint);
  h.update('\0');
  h.update(input.remotePath);
  h.update('\0');
  h.update(input.size);
  h.update('\0');
  h.update(input.modifiedTime === null ? '' : String(input.modifiedTime));
  h.update('\0');
  h.update(input.fileSize === null ? '' : String(input.fileSize));
  return h.digest('hex');
}

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.byteOffset === 0 &&
    bytes.buffer.byteLength === bytes.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

/** On disk: 0x00 = no thumbnail, otherwise 0x01, mime length, mime, payload. */
function encode(value: CachedThumbnail): Buffer {
  if (value.mime === null) return Buffer.from([0]);
  const mime = Buffer.from(value.mime, 'utf8');
  const body = Buffer.from(value.bytes);
  const out = Buffer.alloc(2 + mime.length + body.length);
  out[0] = 1;
  out[1] = mime.length;
  mime.copy(out, 2);
  body.copy(out, 2 + mime.length);
  return out;
}

function decode(buf: Buffer): CachedThumbnail | null {
  if (buf.length < 1 || buf[0] === 0) return { mime: null, bytes: new Uint8Array(0) };
  if (buf[0] !== 1 || buf.length < 2) return null;
  const mimeLen = buf[1]!;
  if (buf.length < 2 + mimeLen) return null;
  const mime = buf.subarray(2, 2 + mimeLen).toString('utf8');
  if (!ALLOWED_MIME.has(mime)) return null;
  return { mime: mime as PreviewMime, bytes: owned(buf.subarray(2 + mimeLen)) };
}

function weight(value: CachedThumbnail): number {
  return 1 + value.bytes.byteLength;
}

interface DiskFile {
  name: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * LRU in memory, size-capped files on disk. Operations are serialized so
 * eviction and a concurrent get cannot delete a file that was just served.
 */
export class PreviewCache {
  readonly hits = { memory: 0, disk: 0, miss: 0 };
  private readonly mem = new Map<string, CachedThumbnail>();
  private memBytes = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly maxDiskBytes = PREVIEW_CACHE_MAX_DISK_BYTES,
    private readonly maxMemoryBytes = PREVIEW_CACHE_MAX_MEMORY_BYTES,
  ) {}

  memoryBytes(): number {
    return this.memBytes;
  }

  memoryHas(key: string): boolean {
    return this.mem.has(key);
  }

  async get(key: string): Promise<CachedThumbnail | null> {
    this.assertKey(key);
    return this.enqueue(async () => {
      const mem = this.memGet(key);
      if (mem) {
        this.hits.memory++;
        return mem;
      }
      const file = this.filePath(key);
      let st;
      try {
        st = await lstat(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.hits.miss++;
          return null;
        }
        throw err;
      }
      // Never follow a symlink planted in the cache directory.
      if (!st.isFile()) {
        this.hits.miss++;
        return null;
      }
      // O_NOFOLLOW: a symlink swapped in after lstat must not be read.
      const flags = constants.O_NOFOLLOW
        ? constants.O_RDONLY | constants.O_NOFOLLOW
        : constants.O_RDONLY;
      let fh;
      try {
        fh = await open(file, flags);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
          this.hits.miss++;
          return null;
        }
        throw err;
      }
      try {
        const buf = await fh.readFile();
        const decoded = decode(buf);
        if (!decoded) {
          this.hits.miss++;
          return null;
        }
        const now = new Date();
        await utimes(file, now, now).catch(() => undefined);
        this.memSet(key, decoded);
        this.hits.disk++;
        return this.copy(decoded);
      } finally {
        await fh.close();
      }
    });
  }

  async put(key: string, value: CachedThumbnail): Promise<void> {
    this.assertKey(key);
    const stored = this.copy(value);
    return this.enqueue(async () => {
      this.memSet(key, stored);
      const body = encode(stored);
      if (body.length > this.maxDiskBytes) return;
      await this.ensureDir();
      await this.sweepJunk();
      const dest = this.filePath(key);
      const tmp = path.join(
        this.dir,
        `.${key}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
      );
      const fh = await open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(body);
        await fh.sync();
      } catch (err) {
        await fh.close();
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      await fh.close();
      try {
        await rename(tmp, dest);
      } catch (err) {
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      await chmod(dest, 0o600).catch(() => undefined);
      await this.evictDisk();
    });
  }

  async clear(): Promise<void> {
    return this.enqueue(async () => {
      this.mem.clear();
      this.memBytes = 0;
      await rm(this.dir, { recursive: true, force: true });
    });
  }

  async diskBytes(): Promise<number> {
    return this.enqueue(async () => {
      const files = await this.listFiles();
      return files.reduce((n, f) => n + f.bytes, 0);
    });
  }

  async files(): Promise<string[]> {
    return this.enqueue(async () => (await this.listFiles()).map((f) => f.name));
  }

  private assertKey(key: string): void {
    if (!KEY.test(key)) throw new Error('Preview cache key must be 64 hex characters.');
  }

  /** Resolved path inside `dir`. The key has already been checked. */
  private filePath(key: string): string {
    const full = path.resolve(this.dir, key);
    const root = path.resolve(this.dir);
    if (full !== path.join(root, key)) throw new Error('Preview cache path escaped its directory.');
    return full;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private copy(value: CachedThumbnail): CachedThumbnail {
    return {
      mime: value.mime,
      bytes: value.mime === null ? new Uint8Array(0) : owned(value.bytes),
    };
  }

  private memGet(key: string): CachedThumbnail | null {
    const v = this.mem.get(key);
    if (!v) return null;
    this.mem.delete(key);
    this.mem.set(key, v);
    return this.copy(v);
  }

  private memSet(key: string, value: CachedThumbnail): void {
    const prev = this.mem.get(key);
    if (prev) {
      this.mem.delete(key);
      this.memBytes -= weight(prev);
    }
    const w = weight(value);
    if (w > this.maxMemoryBytes) return;
    this.mem.set(key, value);
    this.memBytes += w;
    while (this.memBytes > this.maxMemoryBytes && this.mem.size > 0) {
      const oldest = this.mem.keys().next().value;
      if (oldest === undefined) break;
      this.memDrop(oldest);
    }
  }

  private memDrop(key: string): void {
    const prev = this.mem.get(key);
    if (!prev) return;
    this.mem.delete(key);
    this.memBytes -= weight(prev);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => undefined);
  }

  /** Drop temps, symlinks and unexpected names. Symlinks are unlinked, not followed. */
  private async sweepJunk(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      if (KEY.test(e.name) && e.isFile()) continue;
      const full = path.join(this.dir, e.name);
      const st = await lstat(full).catch(() => null);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        await unlink(full).catch(() => undefined);
        continue;
      }
      if (st.isDirectory()) {
        await rm(full, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await unlink(full).catch(() => undefined);
    }
  }

  private async listFiles(): Promise<DiskFile[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: DiskFile[] = [];
    for (const name of names) {
      if (!KEY.test(name)) continue;
      const st = await lstat(this.filePath(name)).catch(() => null);
      if (!st?.isFile()) continue;
      out.push({ name, bytes: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  /** Delete least-recently used files until the directory is under 80% of the cap. */
  private async evictDisk(): Promise<void> {
    const files = await this.listFiles();
    let total = files.reduce((n, f) => n + f.bytes, 0);
    if (total <= this.maxDiskBytes) return;
    const target = Math.floor(this.maxDiskBytes * 0.8);
    files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
    for (const f of files) {
      if (total <= target) break;
      await unlink(this.filePath(f.name)).catch(() => undefined);
      this.memDrop(f.name);
      total -= f.bytes;
    }
  }
}
