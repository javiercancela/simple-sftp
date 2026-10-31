// Grid thumbnails (version 2, outside SPEC.md). Electron-free.
//
// Same rules as the full preview: read-only session, lstat, the 20 MiB cap
// (again while streaming), magic bytes. A newer concern is a directory full of
// images, so this service loads several files at once (a small limit), and
// each request can be cancelled when its tile scrolls away, the folder
// changes, or the connection closes. It does not touch PreviewService, so a
// thumbnail read never aborts the open full preview.
//
// What is cached is the downsized thumbnail, not the original file. The cache
// key includes the live session's profile id and host-key fingerprint, so one
// server's entry cannot be returned for another.
import type { Readable } from 'node:stream';
import {
  SVG_THUMB_MAX_BYTES,
  THUMBNAIL_CONCURRENCY,
  THUMBNAIL_MAX_EDGE,
  PREVIEW_MAX_BYTES,
  detectImageMime,
  type PreviewMime,
  type Thumbnail,
} from '../../shared/preview';
import type { PreviewSize } from '../../shared/settings';
import { normalizeRemotePath } from '../../shared/remote-path';
import { TransportError, isTransportError } from './errors';
import { classifyPreviewError, readCapped } from './preview-service';
import {
  thumbnailCacheKey,
  type CachedThumbnail,
  type PreviewCache,
} from '../platform/preview-cache';
import type { SftpSession } from './transport';

export interface ThumbnailIdentity {
  profileId: string;
  hostFingerprint: string;
}

/** Turns verified image bytes into a grid thumbnail. Null: show the file icon. */
export type ThumbnailEncoder = (
  bytes: Uint8Array,
  mime: PreviewMime,
  maxEdge: number,
) => Promise<{ mime: PreviewMime; bytes: Uint8Array } | null>;

export interface ThumbnailDeps {
  getSession(sessionId: string): SftpSession | null;
  /** Profile and host key of the live session. Never taken from the renderer. */
  getIdentity(sessionId: string): ThumbnailIdentity | null;
  cache: PreviewCache;
  encode: ThumbnailEncoder;
  maxBytes?: number;
  /** Defaults to THUMBNAIL_CONCURRENCY. */
  maxConcurrent?: number;
}

const cancelled = (): TransportError =>
  new TransportError('CANCELLED', 'This preview was cancelled or replaced by a newer one.');
const disconnected = (): TransportError =>
  new TransportError('DISCONNECTED', 'The connection closed while loading the preview.');

const EMPTY: CachedThumbnail = { mime: null, bytes: new Uint8Array(0) };

interface Job {
  abort(): void;
  readonly signal: AbortSignal;
  readonly aborted: boolean;
}

/** At most `max` callers inside `enter`/`leave` at once. Aborting while queued never enters. */
class Gate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  enter(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const wake = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(wake);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(cancelled());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(wake);
    });
  }

  leave(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

export class ThumbnailService {
  private readonly active = new Map<string, Job>();
  private readonly gate: Gate;
  /** Bumped by clearCache so an in-flight read does not repopulate the cache. */
  private epoch = 0;

  constructor(private readonly deps: ThumbnailDeps) {
    this.gate = new Gate(deps.maxConcurrent ?? THUMBNAIL_CONCURRENCY);
  }

  private get max(): number {
    return this.deps.maxBytes ?? PREVIEW_MAX_BYTES;
  }

  async thumbnail(
    sessionId: string,
    requestId: string,
    rawPath: string,
    size: PreviewSize,
  ): Promise<Thumbnail> {
    const session = this.deps.getSession(sessionId);
    const identity = this.deps.getIdentity(sessionId);
    if (!session || !identity)
      throw new TransportError('DISCONNECTED', 'Not connected to this server any more.');

    const id = `${sessionId}\0${requestId}`;
    const job = this.begin(id);
    let closed = false;
    let stream: Readable | null = null;
    const off = session.onClose(() => {
      closed = true;
      job.abort();
      stream?.destroy();
    });
    job.signal.addEventListener('abort', () => stream?.destroy());
    const epoch = this.epoch;

    try {
      const path = normalizeRemotePath(rawPath);
      const st = await session.lstat(path);
      if (closed || this.deps.getSession(sessionId) !== session) throw disconnected();
      if (job.aborted) throw cancelled();
      if (st.type !== 'file')
        throw new TransportError(
          'PREVIEW_NOT_A_FILE',
          'Only regular files can be previewed (not folders or links).',
        );

      const key = thumbnailCacheKey({
        profileId: identity.profileId,
        hostFingerprint: identity.hostFingerprint,
        remotePath: path,
        size,
        modifiedTime: st.modifiedTime,
        fileSize: st.size,
      });
      const reply = (stored: CachedThumbnail): Thumbnail => ({
        sessionId,
        requestId,
        path,
        size,
        mime: stored.mime,
        bytes: stored.bytes,
      });

      if ((st.size ?? 0) > this.max) {
        await this.remember(epoch, key, EMPTY);
        return reply(EMPTY);
      }
      const hit = await this.deps.cache.get(key);
      if (closed || this.deps.getSession(sessionId) !== session) throw disconnected();
      if (job.aborted) throw cancelled();
      if (hit) return reply(hit);

      await this.gate.enter(job.signal);
      try {
        if (closed || this.deps.getSession(sessionId) !== session) throw disconnected();
        if (job.aborted) throw cancelled();
        const again = await this.deps.cache.get(key);
        if (again) return reply(again);
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = await readCapped(session, path, this.max, (s) => {
            stream = s;
            if (job.aborted) s.destroy();
          });
        } catch (err) {
          // Grew past the cap after lstat. Remember that so scrolling back
          // does not read it again until the file's size or mtime changes.
          if (
            isTransportError(err) &&
            err.code === 'PREVIEW_TOO_LARGE' &&
            !job.aborted &&
            !closed &&
            this.deps.getSession(sessionId) === session
          ) {
            await this.remember(epoch, key, EMPTY);
            return reply(EMPTY);
          }
          throw err;
        }
        if (closed || this.deps.getSession(sessionId) !== session) throw disconnected();
        if (job.aborted) throw cancelled();
        const stored = await this.makeThumb(bytes, size);
        await this.remember(epoch, key, stored);
        return reply(stored);
      } finally {
        this.gate.leave();
      }
    } catch (err) {
      if (closed || this.deps.getSession(sessionId) !== session) throw disconnected();
      if (job.aborted) throw cancelled();
      if (isTransportError(err)) throw err;
      throw classifyPreviewError(err);
    } finally {
      off();
      if (this.active.get(id) === job) this.active.delete(id);
    }
  }

  cancel(sessionId: string, requestId: string): boolean {
    const id = `${sessionId}\0${requestId}`;
    const job = this.active.get(id);
    if (!job) return false;
    job.abort();
    this.active.delete(id);
    return true;
  }

  async clearCache(): Promise<void> {
    this.epoch++;
    await this.deps.cache.clear();
  }

  private async makeThumb(bytes: Uint8Array, size: PreviewSize): Promise<CachedThumbnail> {
    const mime = detectImageMime(bytes);
    if (!mime) return EMPTY;
    if (mime === 'image/svg+xml' && bytes.byteLength > SVG_THUMB_MAX_BYTES) return EMPTY;
    const encoded = await this.deps.encode(bytes, mime, THUMBNAIL_MAX_EDGE[size]);
    if (!encoded) return EMPTY;
    const out = new Uint8Array(encoded.bytes.byteLength);
    out.set(encoded.bytes);
    return { mime: encoded.mime, bytes: out };
  }

  private async remember(epoch: number, key: string, value: CachedThumbnail): Promise<void> {
    if (epoch !== this.epoch) return;
    await this.deps.cache.put(key, value);
  }

  private begin(id: string): Job {
    const ac = new AbortController();
    let aborted = false;
    const job: Job = {
      signal: ac.signal,
      get aborted() {
        return aborted;
      },
      abort() {
        aborted = true;
        ac.abort();
      },
    };
    this.active.set(id, job);
    return job;
  }
}
