import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { TransportError } from '../../src/main/connections/errors';
import { PreviewService } from '../../src/main/connections/preview-service';
import type { SftpSession } from '../../src/main/connections/transport';
import {
  PREVIEW_MAX_BYTES,
  applyPreviewResult,
  detectImageMime,
  hasPreviewExtension,
  isPreviewable,
  markCorrupt,
  startPreview,
  stepPreview,
  type ImagePreview,
} from '../../src/shared/preview';
import type { RemoteStat } from '../../src/shared/transport-contract';

const bytes = (...parts: Array<string | number[]>): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );
const PNG = bytes([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 13], 'IHDR');
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('preview: extension (UI only)', () => {
  it.each([
    'a.png',
    'A.PNG',
    'photo.JPeG',
    'x.jpg',
    'x.gif',
    'x.webp',
    'x.svg',
    'x.bmp',
    'x.ico',
    'x.avif',
    'archive.tar.png',
  ])('%s is offered', (n) => expect(hasPreviewExtension(n)).toBe(true));
  it.each(['png', '.png', 'x.png.txt', 'x.', 'x', 'x.svgz', 'x.tiff', 'x.heic', 'x.pdf'])(
    '%s is not offered',
    (n) => expect(hasPreviewExtension(n)).toBe(false),
  );
  it('only regular files with safe names; never links, folders or other', () => {
    expect(isPreviewable({ name: 'a.png', type: 'file', safeName: true })).toBe(true);
    expect(isPreviewable({ name: 'a.png', type: 'symlink', safeName: true })).toBe(false);
    expect(isPreviewable({ name: 'a.png', type: 'directory', safeName: true })).toBe(false);
    expect(isPreviewable({ name: 'a.png', type: 'other', safeName: true })).toBe(false);
    expect(isPreviewable({ name: 'a\n.png', type: 'file', safeName: false })).toBe(false);
  });
});

describe('preview: magic bytes (decided in main)', () => {
  it.each([
    ['png', PNG, 'image/png'],
    ['jpeg', bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'), 'image/jpeg'],
    ['gif87', bytes('GIF87a', [1, 0, 1, 0]), 'image/gif'],
    ['gif89', bytes('GIF89a', [1, 0, 1, 0]), 'image/gif'],
    ['webp', bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '), 'image/webp'],
    ['bmp', bytes('BM', [0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 40, 0, 0, 0]), 'image/bmp'],
    ['ico', bytes([0, 0, 1, 0, 1, 0, 16, 16]), 'image/x-icon'],
    ['avif major', bytes([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0], 'avifmif1miaf'), 'image/avif'],
    ['avif compat', bytes([0, 0, 0, 0x18], 'ftypmif1', [0, 0, 0, 0], 'mif1avif'), 'image/avif'],
    ['svg', text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
    [
      'svg with prolog',
      text(
        '\ufeff<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg>',
      ),
      'image/svg+xml',
    ],
    ['svg doctype subset', text('<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n<svg\n>'), 'image/svg+xml'],
  ])('%s', (_n, b, mime) => expect(detectImageMime(b)).toBe(mime));

  it.each([
    ['empty', new Uint8Array()],
    ['text', text('just some text, renamed to .png')],
    ['html', text('<html><svg></svg></html>')],
    ['svg-ish element', text('<svgfoo>')],
    ['truncated png', PNG.subarray(0, 7)],
    ['BM text', text('BMW owners manual')],
    ['ico with zero images', bytes([0, 0, 1, 0, 0, 0])],
    ['mp4 ftyp', bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 0, 0], 'isomiso2')],
    ['pdf', text('%PDF-1.7')],
    ['binary with NUL before svg', bytes([0], '<svg>')],
    ['zip', bytes('PK', [3, 4])],
  ])('%s is not an image', (_n, b) => expect(detectImageMime(b)).toBeNull());

  it('the extension does not matter: a PNG named .jpg is a PNG', () => {
    expect(detectImageMime(PNG)).toBe('image/png');
  });
});

// ---------- cap logic and request handling (fake session) ----------

function fakeSession(opts: {
  stat?: Partial<RemoteStat> | Error;
  chunks?: Uint8Array[];
  /** Never ends: emits chunks and then waits. */
  hang?: boolean;
  readError?: Error;
}): SftpSession & { reads: number; close(): void } {
  const closers = new Set<(e: TransportError | undefined) => void>();
  const s = {
    reads: 0,
    hostKey: {} as never,
    list: () => Promise.reject(new Error('no')),
    stat: () => Promise.reject(new Error('no')),
    realpath: () => Promise.reject(new Error('no')),
    lstat: () =>
      opts.stat instanceof Error
        ? Promise.reject(opts.stat)
        : Promise.resolve({ type: 'file', size: 10, modifiedTime: null, ...opts.stat } as RemoteStat),
    createReadStream: () => {
      s.reads++;
      if (opts.readError) {
        const r = new Readable({ read() {} });
        setImmediate(() => r.destroy(opts.readError));
        return r;
      }
      const list = [...(opts.chunks ?? [])];
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

const SID = 'session-1';

describe('PreviewService: cap, verification, supersede (fake session)', () => {
  it('returns the bytes and the detected type in a dedicated buffer', async () => {
    const s = fakeSession({ chunks: [PNG.subarray(0, 5), PNG.subarray(5)] });
    const svc = new PreviewService({ getSession: () => s });
    const r = await svc.preview(SID, 'r1', '/a/../img.jpg');
    expect(r).toMatchObject({ sessionId: SID, requestId: 'r1', path: '/img.jpg', mime: 'image/png' });
    expect([...r.bytes]).toEqual([...PNG]);
    expect(r.bytes.byteOffset).toBe(0);
    expect(r.bytes.buffer.byteLength).toBe(PNG.length);
  });

  it('refuses from stat when larger than the cap, without reading', async () => {
    const s = fakeSession({ stat: { size: PREVIEW_MAX_BYTES + 1 } });
    const svc = new PreviewService({ getSession: () => s });
    expect(await code(svc.preview(SID, 'r', '/big.png'))).toBe('PREVIEW_TOO_LARGE');
    expect(s.reads).toBe(0);
  });

  it('exactly the cap is allowed', async () => {
    const big = new Uint8Array(1000);
    big.set(PNG);
    const s = fakeSession({ stat: { size: 1000 }, chunks: [big] });
    const svc = new PreviewService({ getSession: () => s, maxBytes: 1000 });
    expect((await svc.preview(SID, 'r', '/a.png')).size).toBe(1000);
  });

  it('enforces the cap while streaming when the file grew after stat', async () => {
    const chunk = new Uint8Array(400);
    chunk.set(PNG);
    const s = fakeSession({ stat: { size: 400 }, chunks: [chunk, chunk, chunk], hang: true });
    const svc = new PreviewService({ getSession: () => s, maxBytes: 1000 });
    expect(await code(svc.preview(SID, 'r', '/grows.png'))).toBe('PREVIEW_TOO_LARGE');
  });

  it('a file that is not an image is PREVIEW_UNSUPPORTED', async () => {
    const s = fakeSession({ chunks: [text('hello')] });
    const svc = new PreviewService({ getSession: () => s });
    expect(await code(svc.preview(SID, 'r', '/fake.png'))).toBe('PREVIEW_UNSUPPORTED');
  });

  it.each(['symlink', 'directory', 'other'] as const)('a %s is refused', async (type) => {
    const s = fakeSession({ stat: { type } });
    const svc = new PreviewService({ getSession: () => s });
    expect(await code(svc.preview(SID, 'r', '/x.png'))).toBe('PREVIEW_NOT_A_FILE');
    expect(s.reads).toBe(0);
  });

  it('maps open errors: no such file and permission denied', async () => {
    for (const [errno, want] of [
      [3, 'REMOTE_PERMISSION_DENIED'],
      [2, 'REMOTE_NOT_FOUND'],
      [4, 'REMOTE_ERROR'],
    ] as const) {
      const s = fakeSession({ readError: Object.assign(new Error('x'), { code: errno }) });
      const svc = new PreviewService({ getSession: () => s });
      expect(await code(svc.preview(SID, 'r', '/x.png'))).toBe(want);
    }
  });

  it('a newer request supersedes the older one (CANCELLED), and cancel stops a read', async () => {
    const s = fakeSession({ chunks: [PNG], hang: true });
    const svc = new PreviewService({ getSession: () => s });
    const first = code(svc.preview(SID, 'r1', '/a.png'));
    await new Promise((r) => setTimeout(r, 10));
    const second = code(svc.preview(SID, 'r2', '/b.png'));
    expect(await first).toBe('CANCELLED');
    expect(svc.cancel(SID, 'r1')).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.cancel(SID, 'r2')).toBe(true);
    expect(await second).toBe('CANCELLED');
  });

  it('no session, or the session closes mid-read: DISCONNECTED', async () => {
    const none = new PreviewService({ getSession: () => null });
    expect(await code(none.preview(SID, 'r', '/a.png'))).toBe('DISCONNECTED');
    const s = fakeSession({ chunks: [PNG], hang: true });
    const svc = new PreviewService({ getSession: () => s });
    const p = code(svc.preview(SID, 'r', '/a.png'));
    await new Promise((r) => setTimeout(r, 10));
    s.close();
    expect(await p).toBe('DISCONNECTED');
  });
});

describe('preview: renderer request state', () => {
  const ok = (requestId: string): { ok: true; value: ImagePreview } => ({
    ok: true,
    value: {
      sessionId: SID,
      requestId,
      path: '/a.png',
      size: 8,
      mime: 'image/png',
      bytes: PNG,
    },
  });

  it('applies the response for the current request only', () => {
    const s = startPreview(2, 'r2');
    expect(applyPreviewResult(s, 'r1', ok('r1'))).toBe(s);
    expect(applyPreviewResult(s, 'r2', ok('r2')).phase.kind).toBe('ready');
  });

  it('a mismatched echo, a late CANCELLED, or a second response is ignored', () => {
    const s = startPreview(0, 'r2');
    expect(applyPreviewResult(s, 'r2', ok('r1'))).toBe(s);
    expect(
      applyPreviewResult(s, 'r2', { ok: false, error: { code: 'CANCELLED', message: '' } }),
    ).toBe(s);
    const ready = applyPreviewResult(s, 'r2', ok('r2'));
    expect(
      applyPreviewResult(ready, 'r2', { ok: false, error: { code: 'DISCONNECTED', message: 'x' } }),
    ).toBe(ready);
  });

  it('errors and decode failures become error phases', () => {
    const s = startPreview(0, 'r');
    const e = applyPreviewResult(s, 'r', {
      ok: false,
      error: { code: 'PREVIEW_TOO_LARGE', message: 'big' },
    });
    expect(e.phase).toEqual({ kind: 'error', code: 'PREVIEW_TOO_LARGE', message: 'big' });
    const ready = applyPreviewResult(s, 'r', ok('r'));
    expect(markCorrupt(ready, 'old')).toBe(ready);
    expect(markCorrupt(ready, 'r').phase).toMatchObject({ kind: 'error', code: 'PREVIEW_CORRUPT' });
  });

  it('prev/next stay inside the folder', () => {
    expect(stepPreview(0, 3, -1)).toBeNull();
    expect(stepPreview(0, 3, 1)).toBe(1);
    expect(stepPreview(2, 3, 1)).toBeNull();
  });
});
