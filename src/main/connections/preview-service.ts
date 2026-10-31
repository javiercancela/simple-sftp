// Image preview (version 2 feature, outside SPEC.md). Electron-free.
//
// DELIBERATE EXCEPTION to spec 7.2 ("no file bytes through renderer IPC"):
// this is the only place file contents go to the renderer. The bytes are read
// through the same read-only session, capped at PREVIEW_MAX_BYTES (checked
// against stat and again while streaming), verified as an image by magic bytes,
// and kept in memory only. Downloads never send bytes to the renderer.
//
// One preview at a time per session: a newer request (or a cancel) aborts the
// older read and the older request resolves to CANCELLED.
import type { Readable } from 'node:stream';
import { PREVIEW_MAX_BYTES, detectImageMime, type ImagePreview } from '../../shared/preview';
import { normalizeRemotePath } from '../../shared/remote-path';
import { formatSize } from '../../shared/browse';
import { TransportError, isTransportError } from './errors';
import type { SftpSession } from './transport';

export interface PreviewDeps {
  getSession(sessionId: string): SftpSession | null;
  /** Defaults to PREVIEW_MAX_BYTES; lowered in tests. */
  maxBytes?: number;
  /** Test seam: runs after stat and before the read (e.g. to grow the file). */
  afterStat?: (path: string) => Promise<void>;
}

const superseded = (): TransportError =>
  new TransportError('CANCELLED', 'This preview was cancelled or replaced by a newer one.');
const tooLarge = (max: number): TransportError =>
  new TransportError(
    'PREVIEW_TOO_LARGE',
    `This image is too large to preview (the limit is ${formatSize(max)}). Download it instead.`,
  );

interface Active {
  requestId: string;
  abort: () => void;
}

export class PreviewService {
  private readonly active = new Map<string, Active>();

  constructor(private readonly deps: PreviewDeps) {}

  private get max(): number {
    return this.deps.maxBytes ?? PREVIEW_MAX_BYTES;
  }

  async preview(sessionId: string, requestId: string, rawPath: string): Promise<ImagePreview> {
    const session = this.deps.getSession(sessionId);
    if (!session)
      throw new TransportError('DISCONNECTED', 'Not connected to this server any more.');
    const path = normalizeRemotePath(rawPath);

    this.active.get(sessionId)?.abort();
    let aborted = false;
    let closed = false;
    let stream: Readable | null = null;
    const stop = (): void => {
      stream?.destroy();
    };
    this.active.set(sessionId, {
      requestId,
      abort: () => {
        aborted = true;
        stop();
      },
    });
    const offClose = session.onClose(() => {
      closed = true;
      stop();
    });
    const live = (): boolean => !aborted;
    try {
      const st = await session.lstat(path);
      if (!live()) throw superseded();
      if (st.type !== 'file')
        throw new TransportError(
          'PREVIEW_NOT_A_FILE',
          'Only regular files can be previewed (not folders or links).',
        );
      if ((st.size ?? 0) > this.max) throw tooLarge(this.max);
      await this.deps.afterStat?.(path);
      if (!live()) throw superseded();
      const bytes = await this.read(session, path, (s) => {
        stream = s;
      });
      if (!live()) throw superseded();
      const mime = detectImageMime(bytes);
      if (!mime)
        throw new TransportError(
          'PREVIEW_UNSUPPORTED',
          "This file isn't a supported image. Its contents don't match its name.",
        );
      return { sessionId, requestId, path, size: bytes.byteLength, mime, bytes };
    } catch (err) {
      if (!live()) throw superseded();
      if (closed || this.deps.getSession(sessionId) !== session)
        throw new TransportError(
          'DISCONNECTED',
          'The connection closed while loading the preview.',
        );
      throw classify(err);
    } finally {
      offClose();
      if (this.active.get(sessionId)?.requestId === requestId) this.active.delete(sessionId);
    }
  }

  cancel(sessionId: string, requestId: string): boolean {
    const a = this.active.get(sessionId);
    if (a?.requestId !== requestId) return false;
    a.abort();
    this.active.delete(sessionId);
    return true;
  }

  /** Reads the whole file, failing as soon as it passes the cap (it may grow). */
  private read(
    session: SftpSession,
    path: string,
    track: (s: Readable) => void,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const max = this.max;
    return new Promise((resolve, reject) => {
      const s = session.createReadStream(path);
      track(s);
      const chunks: Buffer[] = [];
      let total = 0;
      let done = false;
      const fail = (e: unknown): void => {
        if (done) return;
        done = true;
        s.destroy();
        reject(e);
      };
      s.on('data', (c: Buffer) => {
        total += c.length;
        if (total > max) return fail(tooLarge(max));
        chunks.push(c);
      });
      s.on('error', fail);
      s.on('end', () => {
        if (done) return;
        done = true;
        // A dedicated ArrayBuffer: a pooled Buffer view would send unrelated
        // memory with the structured clone.
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        resolve(out);
      });
      s.on('close', () => fail(superseded()));
    });
  }
}

function classify(err: unknown): TransportError {
  if (isTransportError(err)) return err;
  const code = (err as { code?: unknown })?.code;
  // SSH_FX_NO_SUCH_FILE = 2, SSH_FX_PERMISSION_DENIED = 3
  if (code === 2) return new TransportError('REMOTE_NOT_FOUND', 'The remote path does not exist.');
  if (code === 3)
    return new TransportError('REMOTE_PERMISSION_DENIED', 'Permission denied on the server.');
  return new TransportError('REMOTE_ERROR', 'Could not read this file.');
}
