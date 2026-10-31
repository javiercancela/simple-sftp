// Downscale a verified image to a PNG thumbnail using Electron's decoder.
// SVG is not rasterized. Formats nativeImage cannot decode (GIF, WebP, AVIF,
// some BMP/ICO) are kept unchanged when they are small; <img> shows them and
// does not run scripts. Anything larger than that becomes "no thumbnail".
import { nativeImage } from 'electron';
import { SVG_THUMB_MAX_BYTES } from '../../shared/preview';
import type { ThumbnailEncoder } from '../connections/thumbnail-service';

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

export const encodeThumbnail: ThumbnailEncoder = async (bytes, mime, maxEdge) => {
  if (mime === 'image/svg+xml') {
    if (bytes.byteLength > SVG_THUMB_MAX_BYTES) return null;
    return { mime: 'image/svg+xml', bytes: owned(bytes) };
  }
  const scaled = raster(bytes, maxEdge);
  if (scaled) return scaled;
  // nativeImage decodes PNG and JPEG. GIF, WebP, AVIF and some BMP/ICO files
  // come back empty; a small original is still shown by <img> and is cached.
  if (bytes.byteLength > SVG_THUMB_MAX_BYTES) return null;
  return { mime, bytes: owned(bytes) };
};

function raster(
  bytes: Uint8Array,
  maxEdge: number,
): { mime: 'image/png'; bytes: Uint8Array<ArrayBuffer> } | null {
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (width <= 0 || height <= 0) return null;
  const edge = Math.max(width, height);
  const scale = Math.min(1, maxEdge / edge);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const sized = scale < 1 ? img.resize({ width: w, height: h, quality: 'good' }) : img;
  const png = sized.toPNG();
  if (png.length === 0) return null;
  return { mime: 'image/png', bytes: owned(png) };
}
