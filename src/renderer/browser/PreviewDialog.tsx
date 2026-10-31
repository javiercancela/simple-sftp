// Image preview (version 2 feature, outside SPEC.md). Shows one remote image
// from memory: the bytes come from main (capped, magic-byte checked) and are
// shown through a blob: URL in <img>, so SVG scripts never run and nothing is
// fetched or written to disk. Prev/Next step through the folder's images; a
// newer request supersedes the older one and late responses are ignored.
import { useEffect, useMemo, useState } from 'react';
import { formatSize, type BrowseEntry } from '../../shared/browse';
import {
  PREVIEW_ERROR,
  PREVIEW_MAX_BYTES,
  applyPreviewResult,
  markCorrupt,
  startPreview,
  stepPreview,
  type PreviewState,
} from '../../shared/preview';
import { displayName, joinRemote } from '../../shared/remote-path';
import { api } from '../api';
import { Dialog } from '../components/Dialog';

const LOADING_DELAY_MS = 120;

function errorText(code: string, message: string): { title: string; detail: string } {
  switch (code) {
    case PREVIEW_ERROR.tooLarge:
      return {
        title: 'Too large to preview',
        detail: `Images up to ${formatSize(PREVIEW_MAX_BYTES)} can be previewed. Download this one instead.`,
      };
    case PREVIEW_ERROR.unsupported:
      return {
        title: 'Not a supported image',
        detail: "This file's contents aren't a PNG, JPEG, GIF, WebP, SVG, BMP, ICO or AVIF image.",
      };
    case PREVIEW_ERROR.corrupt:
      return { title: "Couldn't display this image", detail: 'The image may be damaged.' };
    case PREVIEW_ERROR.notAFile:
      return { title: "Can't preview this item", detail: message };
    case 'REMOTE_NOT_FOUND':
      return { title: 'File not found', detail: "This file doesn't exist on the server any more." };
    case 'REMOTE_PERMISSION_DENIED':
      return {
        title: 'Permission denied',
        detail: "The server doesn't allow your account to read this file.",
      };
    case 'DISCONNECTED':
      return { title: 'Not connected', detail: message };
    default:
      return { title: "Couldn't load the preview", detail: message };
  }
}

export function PreviewDialog({
  sessionId,
  dir,
  images,
  startIndex,
  onClose,
  onDownload,
}: {
  sessionId: string;
  dir: string;
  /** Previewable images of the current folder, in view order. */
  images: BrowseEntry[];
  startIndex: number;
  /** Called with the name of the image shown last. */
  onClose: (lastName: string) => void;
  onDownload: (path: string) => void;
}): React.JSX.Element {
  const [state, setState] = useState<PreviewState>(() =>
    startPreview(startIndex, crypto.randomUUID()),
  );
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // Request that has been loading long enough to show a spinner (timer only).
  const [slowFor, setSlowFor] = useState<string | null>(null);
  const entry = images[state.index]!;
  const path = joinRemote(dir, entry.name);
  const { requestId } = state;

  // One request per (index, requestId); cancelling it on change or close.
  useEffect(() => {
    let done = false;
    const t = setTimeout(() => setSlowFor(requestId), LOADING_DELAY_MS);
    void api()
      .remote.previewImage(sessionId, requestId, path)
      .then((r) => {
        done = true;
        setState((s) => applyPreviewResult(s, requestId, r));
      });
    return () => {
      clearTimeout(t);
      if (!done) void api().remote.cancelPreview(sessionId, requestId);
    };
  }, [sessionId, requestId, path]);

  const ready = state.phase.kind === 'ready' ? state.phase.preview : null;
  const url = useMemo(
    () => (ready ? URL.createObjectURL(new Blob([ready.bytes], { type: ready.mime })) : null),
    [ready],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  const go = (step: -1 | 1): void => {
    const next = stepPreview(state.index, images.length, step);
    if (next === null) return;
    setDims(null);
    setState(startPreview(next, crypto.randomUUID()));
  };
  const close = (): void => onClose(entry.name);

  const name = displayName(entry.name);
  const err =
    state.phase.kind === 'error' ? errorText(state.phase.code, state.phase.message) : null;
  const size = ready?.size ?? entry.size;

  return (
    <Dialog
      title={name}
      onClose={close}
      testId="preview-dialog"
      className="preview-dialog"
      initialFocusId="preview-close"
      onKeyDown={(e) => {
        // Keep keys inside the preview (the browser's own shortcuts would
        // otherwise navigate the folder underneath).
        e.stopPropagation();
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          go(e.key === 'ArrowLeft' ? -1 : 1);
        }
      }}
    >
      <p className="dialog-sub preview-meta" data-testid="preview-meta">
        {ready?.mime.replace('image/', '').replace('+xml', '').toUpperCase() ?? 'Image'}
        {dims ? ` · ${dims.w} × ${dims.h} px` : ''}
        {size !== null ? ` · ${formatSize(size)}` : ''}
        {images.length > 1 ? ` · ${state.index + 1} of ${images.length}` : ''}
      </p>
      <div
        className="preview-stage"
        data-testid="preview-stage"
        data-state={state.phase.kind}
        data-request-id={requestId}
        data-name={entry.name}
      >
        {state.phase.kind === 'loading' && slowFor === requestId && (
          <div className="preview-status" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            Loading preview…
          </div>
        )}
        {url && ready && (
          <img
            key={requestId}
            src={url}
            alt={`Preview of ${name}`}
            data-testid="preview-image"
            data-mime={ready.mime}
            draggable={false}
            onLoad={(e) =>
              setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
            onError={() => setState((s) => markCorrupt(s, requestId))}
          />
        )}
        {err && state.phase.kind === 'error' && (
          <div
            className="preview-status preview-error"
            role="alert"
            data-testid="preview-error"
            data-code={state.phase.code}
          >
            <h3>{err.title}</h3>
            <p>{err.detail}</p>
          </div>
        )}
      </div>
      <div className="dialog-actions preview-actions">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={state.index === 0}
          aria-label="Previous image"
          title="Previous image (Left arrow)"
        >
          ← Prev
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={state.index >= images.length - 1}
          aria-label="Next image"
          title="Next image (Right arrow)"
        >
          Next →
        </button>
        <span className="spacer" />
        <button
          type="button"
          className={
            state.phase.kind === 'error' && state.phase.code === PREVIEW_ERROR.tooLarge
              ? 'primary'
              : undefined
          }
          data-testid="preview-download"
          onClick={() => {
            onDownload(path);
            close();
          }}
        >
          Download
        </button>
        <button type="button" id="preview-close" onClick={close} title="Close (Esc)">
          Close
        </button>
      </div>
    </Dialog>
  );
}
