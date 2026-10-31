// Image preview (version 2 feature, outside SPEC.md). Pure helpers shared by
// main and the renderer: which names are offered for preview (by extension,
// UI only), what the bytes really are (magic bytes, decided in main), the size
// cap, and the renderer's request state (stale responses are ignored).
import type { BrowseEntry } from './browse';
import type { IpcResult } from './ipc-contract';

/** Hard cap on bytes read for one preview; larger files are offered for download. */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

export const PREVIEW_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
] as const;

export const PREVIEW_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/x-icon',
  'image/avif',
] as const;
export type PreviewMime = (typeof PREVIEW_MIMES)[number];

/** Extension check for the UI only; main decides from the bytes. */
export function hasPreviewExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return (PREVIEW_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}

/** Regular files (never links) with a safe name and an image extension. */
export function isPreviewable(e: Pick<BrowseEntry, 'name' | 'type' | 'safeName'>): boolean {
  return e.type === 'file' && e.safeName && hasPreviewExtension(e.name);
}

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};
const u32be = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number): number =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/** BMP info-header sizes (OS/2 and Windows variants). */
const BMP_DIB_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);
const SVG_SNIFF_BYTES = 4096;

/**
 * Detects the image format from the file's leading bytes. Returns null for
 * anything that is not one of the supported formats; the extension is ignored.
 */
export function detectImageMime(b: Uint8Array): PreviewMime | null {
  if (
    b.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)
  )
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'image/gif';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  if (ascii(b, 0, 'BM') && b.length >= 18 && BMP_DIB_SIZES.has(u32le(b, 14))) return 'image/bmp';
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4]! | b[5]!) !== 0)
    return 'image/x-icon';
  if (isAvif(b)) return 'image/avif';
  if (isSvg(b)) return 'image/svg+xml';
  return null;
}

/** ISO-BMFF "ftyp" box whose major or compatible brands include avif/avis. */
function isAvif(b: Uint8Array): boolean {
  if (!ascii(b, 4, 'ftyp') || b.length < 16) return false;
  const size = Math.min(u32be(b, 0), b.length);
  if (size < 16) return false;
  for (let at = 8; at + 4 <= size; at += at === 8 ? 8 : 4) {
    if (ascii(b, at, 'avif') || ascii(b, at, 'avis')) return true;
  }
  return false;
}

/**
 * Text whose root element is <svg>, after an optional BOM, XML declaration,
 * comments, processing instructions and a DOCTYPE. Binary data never matches.
 */
function isSvg(b: Uint8Array): boolean {
  const head = b.subarray(0, SVG_SNIFF_BYTES);
  if (head.includes(0)) return false;
  let s = new TextDecoder('utf-8').decode(head);
  if (s.startsWith('\ufeff')) s = s.slice(1);
  for (;;) {
    s = s.replace(/^\s+/, '');
    const skip = (open: string, close: string): boolean => {
      if (!s.startsWith(open)) return false;
      const end = s.indexOf(close, open.length);
      s = end < 0 ? '' : s.slice(end + close.length);
      return true;
    };
    if (skip('<?', '?>') || skip('<!--', '-->')) continue;
    if (s.startsWith('<!DOCTYPE')) {
      const bracket = s.indexOf('[');
      const gt = s.indexOf('>');
      if (bracket >= 0 && (gt < 0 || bracket < gt)) skip('<!DOCTYPE', ']>');
      else skip('<!DOCTYPE', '>');
      continue;
    }
    break;
  }
  return /^<svg[\s>/]/.test(s);
}

/** Preview of one remote image, as returned by main. */
export interface ImagePreview {
  sessionId: string;
  requestId: string;
  path: string;
  size: number;
  mime: PreviewMime;
  /** The file's bytes (at most PREVIEW_MAX_BYTES). Never written to disk. */
  bytes: Uint8Array;
}

/** Preview-specific error codes (the transport codes also apply). */
export const PREVIEW_ERROR = {
  tooLarge: 'PREVIEW_TOO_LARGE',
  unsupported: 'PREVIEW_UNSUPPORTED',
  notAFile: 'PREVIEW_NOT_A_FILE',
  /** Renderer-side: the bytes looked like an image but did not decode. */
  corrupt: 'PREVIEW_CORRUPT',
} as const;

// ---------- renderer request state ----------

export type PreviewPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; preview: ImagePreview }
  | { kind: 'error'; code: string; message: string };

export interface PreviewState {
  requestId: string;
  /** Index into the folder's previewable images. */
  index: number;
  phase: PreviewPhase;
}

export function startPreview(index: number, requestId: string): PreviewState {
  return { requestId, index, phase: { kind: 'loading' } };
}

/**
 * Applies a response from main. A response for any other request (superseded
 * by a newer selection) is ignored, and so is a late CANCELLED for this one.
 */
export function applyPreviewResult(
  state: PreviewState,
  requestId: string,
  r: IpcResult<ImagePreview>,
): PreviewState {
  if (state.requestId !== requestId || state.phase.kind !== 'loading') return state;
  if (r.ok)
    return r.value.requestId === requestId
      ? { ...state, phase: { kind: 'ready', preview: r.value } }
      : state;
  if (r.error.code === 'CANCELLED') return state;
  return { ...state, phase: { kind: 'error', code: r.error.code, message: r.error.message } };
}

/** The image did not decode in <img>: same request, error phase. */
export function markCorrupt(state: PreviewState, requestId: string): PreviewState {
  if (state.requestId !== requestId || state.phase.kind !== 'ready') return state;
  return {
    ...state,
    phase: {
      kind: 'error',
      code: PREVIEW_ERROR.corrupt,
      message: "The image couldn't be displayed. It may be damaged.",
    },
  };
}

/** Prev/Next without wrapping; null when there is nowhere to go. */
export function stepPreview(index: number, count: number, dir: -1 | 1): number | null {
  const next = index + dir;
  return next < 0 || next >= count ? null : next;
}
