// Single remote file browser (spec 6): navigation bar, location field,
// breadcrumbs, filter, hidden toggle, sortable virtualized table, and
// distinct loading / empty / denied / not-found states. Read-only.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SORT,
  canBack,
  canForward,
  clickSelect,
  emptySelection,
  filterEntries,
  gridKeySelect,
  isDirLike,
  isHidden,
  keySelect,
  reconcileSelection,
  selectAll,
  sortEntries,
  toggleActive,
  type BrowseEntry,
  type GridNavKey,
  type NavKey,
  type Selection,
  type SortKey,
  type SortSpec,
} from '../../shared/browse';
import {
  breadcrumbs,
  displayName,
  joinRemote,
  parentOf,
  resolveLocationInput,
} from '../../shared/remote-path';
import { isPreviewable } from '../../shared/preview';
import type { BrowserView, PreviewSize } from '../../shared/settings';
import { FileTable } from './FileTable';
import { PreviewDialog } from './PreviewDialog';
import { PreviewGrid } from './PreviewGrid';
import { useBrowser, type BrowserApi, type BrowserSession } from './useBrowser';

const LOADING_DELAY_MS = 150;
const isMac = navigator.platform.toLowerCase().includes('mac');
const NAV_KEYS: Record<string, NavKey> = {
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};
const GRID_KEYS: Record<string, GridNavKey> = {
  ...NAV_KEYS,
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
};

export function Browser({
  session,
  viewMode,
  previewSize,
  onViewMode,
  onPreviewSize,
  onDownload,
}: {
  session: BrowserSession;
  viewMode: BrowserView;
  previewSize: PreviewSize;
  onViewMode(mode: BrowserView): void;
  onPreviewSize(size: PreviewSize): void;
  /** Ask main to choose a destination and queue these remote files. */
  onDownload: (paths: string[]) => void;
}): React.JSX.Element {
  const b = useBrowser(session);
  const [sort, setSort] = useState<SortSpec>(DEFAULT_SORT);
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [message, setMessage] = useState<string | null>(null);
  const [locationDraft, setLocationDraft] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  // Request ID of the listing that has been running long enough to show a
  // loading state (set from a timer, never synchronously).
  const [slowRequest, setSlowRequest] = useState<string | null>(null);
  const locationRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{
    dir: string;
    images: BrowseEntry[];
    index: number;
  } | null>(null);

  const view = b.view;
  const viewPath = view.kind === 'none' ? null : view.path;

  // Folder changed: clear filter, selection and messages. (A refresh of the
  // same folder keeps the selection for names that still exist.)
  const [shownPath, setShownPath] = useState(viewPath);
  if (shownPath !== viewPath) {
    setShownPath(viewPath);
    setQuery('');
    setSelection(emptySelection());
    setMessage(null);
  }

  // A slow listing shows the loading state after a short delay; the rest of
  // the UI (navigation, cancel, filter) stays usable.
  const pendingId = b.pending?.requestId ?? null;
  useEffect(() => {
    if (!pendingId) return;
    const t = setTimeout(() => setSlowRequest(pendingId), LOADING_DELAY_MS);
    return () => clearTimeout(t);
  }, [pendingId]);

  const all = useMemo(() => (view.kind === 'ready' ? view.entries : []), [view]);
  const sorted = useMemo(() => sortEntries(all, sort), [all, sort]);
  const visible = useMemo(
    () => filterEntries(sorted, { query, showHidden }),
    [sorted, query, showHidden],
  );
  const names = useMemo(() => visible.map((e) => e.name), [visible]);
  // Keep the selection to names that are still visible (filter, refresh).
  const [selectionNames, setSelectionNames] = useState(names);
  if (selectionNames !== names) {
    setSelectionNames(names);
    setSelection((s) => reconcileSelection(s, names));
  }
  const hiddenCount = useMemo(() => all.filter((e) => isHidden(e.name)).length, [all]);

  // Only regular files are downloaded; remote content is never opened or run.
  const requestDownload = (entries: BrowseEntry[]): void => {
    if (view.kind !== 'ready') return;
    const files = entries.filter((e) => e.type === 'file' && e.safeName);
    const skipped = entries.length - files.length;
    setMessage(
      skipped === 0
        ? null
        : `${skipped} selected item${skipped === 1 ? ' is' : 's are'} not ${skipped === 1 ? 'a regular file' : 'regular files'} and ${skipped === 1 ? 'was' : 'were'} skipped. Folders and links can't be downloaded in this version.`,
    );
    if (files.length > 0) onDownload(files.map((e) => joinRemote(view.path, e.name)));
  };
  const selectedEntries = visible.filter((e) => selection.selected.has(e.name));
  const selectedFiles = selectedEntries.filter((e) => e.type === 'file').length;

  // Image preview (version 2): the single selected item, else the active row.
  const previewTarget =
    selectedEntries.length === 1
      ? selectedEntries[0]
      : selection.active !== null
        ? visible[selection.active]
        : undefined;
  const canPreview = view.kind === 'ready' && !!previewTarget && isPreviewable(previewTarget);
  const openPreview = (e: BrowseEntry | undefined): void => {
    if (view.kind !== 'ready' || !e) return;
    if (!isPreviewable(e)) {
      setMessage(
        `“${displayName(e.name)}” can't be previewed. Only image files (PNG, JPEG, GIF, WebP, SVG, BMP, ICO, AVIF) can.`,
      );
      return;
    }
    const images = visible.filter(isPreviewable);
    setMessage(null);
    setPreview({ dir: view.path, images, index: Math.max(0, images.indexOf(e)) });
  };
  const closePreview = (lastName: string): void => {
    setPreview(null);
    const i = names.indexOf(lastName);
    if (i >= 0) setSelection({ selected: new Set([lastName]), active: i, anchor: i });
  };

  const open = (e: BrowseEntry): void => {
    if (view.kind !== 'ready') return;
    const shown = displayName(e.name);
    if (!e.safeName) {
      setMessage(`“${shown}” has a name that can't be used safely, so it can't be opened.`);
    } else if (isDirLike(e)) {
      b.navigate(joinRemote(view.path, e.name));
    } else if (e.type === 'symlink') {
      setMessage(
        e.linkTarget === 'broken'
          ? `“${shown}” is a broken link.`
          : `“${shown}” is a link. Links can't be downloaded in this version.`,
      );
    } else if (e.type === 'file') {
      requestDownload([e]);
    } else {
      setMessage(`“${shown}” is not a regular file or folder.`);
    }
  };

  const onSelectionKey = (ev: React.KeyboardEvent, apply: () => void): void => {
    const toggle = isMac ? ev.metaKey : ev.ctrlKey;
    if ((viewMode === 'preview' ? GRID_KEYS[ev.key] : NAV_KEYS[ev.key]) && !ev.altKey) {
      ev.preventDefault();
      apply();
    } else if (ev.key === 'a' && toggle) {
      ev.preventDefault();
      setSelection((s) => selectAll(names, s));
    } else if (ev.key === ' ' && toggle) {
      ev.preventDefault();
      setSelection((s) => toggleActive(s, names));
    } else if (ev.key === ' ' && !ev.shiftKey && !ev.altKey && !toggle) {
      ev.preventDefault();
      openPreview(previewTarget);
    } else if (ev.key === 'Enter' && selection.active !== null) {
      ev.preventDefault();
      const e = visible[selection.active];
      if (e) open(e);
    } else if (ev.key === 'Escape' && !b.pending) {
      setSelection((s) => ({ ...s, selected: new Set() }));
    }
  };

  // Browser-wide shortcuts (platform style).
  const onBrowserKeyDown = (ev: React.KeyboardEvent): void => {
    const mod = isMac ? ev.metaKey : ev.ctrlKey;
    const inField = (ev.target as HTMLElement).tagName === 'INPUT';
    if ((ev.altKey && ev.key === 'ArrowLeft') || (isMac && ev.metaKey && ev.key === '[')) {
      ev.preventDefault();
      b.back();
    } else if ((ev.altKey && ev.key === 'ArrowRight') || (isMac && ev.metaKey && ev.key === ']')) {
      ev.preventDefault();
      b.forward();
    } else if ((ev.altKey && ev.key === 'ArrowUp') || (!inField && ev.key === 'Backspace')) {
      ev.preventDefault();
      b.up();
    } else if (ev.key === 'F5' || (mod && ev.key === 'r')) {
      ev.preventDefault();
      b.refresh();
    } else if (mod && ev.key === 'l') {
      ev.preventDefault();
      locationRef.current?.focus();
      locationRef.current?.select();
    } else if (mod && ev.key === 'f') {
      ev.preventDefault();
      filterRef.current?.focus();
    } else if (ev.key === 'Escape' && b.pending) {
      ev.preventDefault();
      b.cancel();
    }
  };

  const submitLocation = (): void => {
    const target = resolveLocationInput(locationDraft ?? b.location, viewPath ?? '/');
    if (!target) {
      setLocationError('Enter a folder path such as /srv/files.');
      return;
    }
    setLocationError(null);
    setLocationDraft(null);
    b.navigate(target);
  };

  const onSort = (key: SortKey): void =>
    setSort((s) =>
      s.key === key
        ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'name' ? 'asc' : 'desc' },
    );

  const crumbPath = b.pending?.path ?? viewPath;
  const crumbs = crumbPath ? breadcrumbs(crumbPath) : [];
  const loadingState =
    b.pending !== null && (slowRequest === b.pending.requestId || view.kind === 'none');

  let body: React.JSX.Element;
  if (loadingState) {
    body = (
      <div
        className="browser-state"
        data-testid="browser-state-loading"
        role="status"
        aria-live="polite"
      >
        <span className="spinner" aria-hidden="true" />
        <p>
          Loading <span className="mono">{displayName(b.pending!.path)}</span>…
        </p>
        <button type="button" onClick={b.cancel}>
          Cancel
        </button>
      </div>
    );
  } else if (view.kind === 'error') {
    body = <ErrorState view={view} session={session} b={b} />;
  } else if (view.kind === 'ready' && all.length === 0) {
    body = (
      <div className="browser-state" data-testid="browser-state-empty">
        <h2>This folder is empty</h2>
      </div>
    );
  } else if (view.kind === 'ready' && visible.length === 0) {
    body = (
      <div className="browser-state" data-testid="browser-state-no-match">
        <h2>{query.trim() ? `No items match “${query.trim()}”` : 'Only hidden items here'}</h2>
        <p>
          {query.trim()
            ? 'The filter only searches this folder, not subfolders.'
            : 'Turn on Show hidden files to see them.'}
        </p>
      </div>
    );
  } else if (view.kind === 'ready') {
    const onRowClick = (i: number, ev: React.MouseEvent): void =>
      setSelection((s) =>
        clickSelect(s, names, i, {
          shift: ev.shiftKey,
          toggle: isMac ? ev.metaKey : ev.ctrlKey,
        }),
      );
    const onRowOpen = (i: number): void => {
      const e = visible[i];
      if (e) open(e);
    };
    body =
      viewMode === 'preview' ? (
        <PreviewGrid
          key={`${view.path}:${previewSize}`}
          entries={visible}
          selection={selection}
          dir={view.path}
          sessionId={session.sessionId}
          size={previewSize}
          onRowClick={onRowClick}
          onRowOpen={onRowOpen}
          onKeyDown={(ev, columns, pageRows) =>
            onSelectionKey(ev, () => {
              const k = GRID_KEYS[ev.key];
              if (!k) return;
              const toggle = isMac ? ev.metaKey : ev.ctrlKey;
              setSelection((s) =>
                gridKeySelect(s, names, k, columns, { shift: ev.shiftKey, toggle }, pageRows),
              );
            })
          }
        />
      ) : (
        <FileTable
          entries={visible}
          selection={selection}
          sort={sort}
          onSort={onSort}
          key={view.path}
          onRowClick={onRowClick}
          onRowOpen={onRowOpen}
          onKeyDown={(ev, pageSize) =>
            onSelectionKey(ev, () => {
              const k = NAV_KEYS[ev.key];
              if (!k) return;
              const toggle = isMac ? ev.metaKey : ev.ctrlKey;
              setSelection((s) => keySelect(s, names, k, { shift: ev.shiftKey, toggle }, pageSize));
            })
          }
        />
      );
  } else {
    body = <div className="browser-state" />;
  }

  return (
    <div
      className="browser"
      data-testid="browser"
      data-view-path={viewPath ?? ''}
      data-view-kind={view.kind}
      data-view-mode={viewMode}
      data-preview-size={previewSize}
      data-busy={b.pending ? 'true' : 'false'}
      onKeyDown={onBrowserKeyDown}
    >
      <div className="browser-nav" role="toolbar" aria-label="Remote navigation">
        <button
          type="button"
          onClick={b.back}
          disabled={!canBack(b.history)}
          aria-label="Back"
          title="Back (Alt+Left)"
        >
          ←
        </button>
        <button
          type="button"
          onClick={b.forward}
          disabled={!canForward(b.history)}
          aria-label="Forward"
          title="Forward (Alt+Right)"
        >
          →
        </button>
        <button
          type="button"
          onClick={b.up}
          disabled={!viewPath || viewPath === '/'}
          aria-label="Parent folder"
          title="Parent folder (Alt+Up)"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={b.refresh}
          disabled={!viewPath}
          aria-label="Refresh"
          title="Refresh (F5)"
        >
          ⟳
        </button>
        <button
          type="button"
          onClick={b.goHome}
          aria-label="Server default folder"
          title={`Server default folder${session.home ? ` (${session.home})` : ''}`}
        >
          ⌂
        </button>
        <form
          className="location-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            submitLocation();
          }}
        >
          <input
            ref={locationRef}
            className="mono location"
            type="text"
            aria-label="Location"
            spellCheck={false}
            autoComplete="off"
            value={locationDraft ?? b.location}
            aria-invalid={locationError ? true : undefined}
            aria-describedby={locationError ? 'location-error' : undefined}
            onChange={(ev) => setLocationDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Escape') {
                setLocationDraft(null);
                setLocationError(null);
              }
            }}
            onBlur={() => {
              if (!locationError) setLocationDraft(null);
            }}
          />
        </form>
      </div>
      {locationError && (
        <p id="location-error" className="field-error location-error" role="alert">
          {locationError}
        </p>
      )}
      <nav className="breadcrumbs" aria-label="Breadcrumb" data-testid="breadcrumbs">
        <ol>
          {crumbs.map((c, i) => (
            <li key={c.path}>
              <button
                type="button"
                className="crumb"
                aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                onClick={() => b.navigate(c.path)}
              >
                {displayName(c.label)}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="browser-tools">
        <input
          ref={filterRef}
          className="filter"
          type="search"
          placeholder="Filter this folder"
          aria-label="Filter this folder"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          disabled={view.kind !== 'ready'}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(ev) => setShowHidden(ev.target.checked)}
          />
          Show hidden files
        </label>
        <div className="view-toggle" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={viewMode === 'list'}
            data-testid="view-list"
            title="List"
            onClick={() => onViewMode('list')}
          >
            List
          </button>
          <button
            type="button"
            aria-pressed={viewMode === 'preview'}
            data-testid="view-preview"
            title="Preview"
            onClick={() => onViewMode('preview')}
          >
            Preview
          </button>
        </div>
        {viewMode === 'preview' && (
          <div className="view-toggle" role="group" aria-label="Preview size">
            <button
              type="button"
              aria-pressed={previewSize === 'small'}
              data-testid="preview-size-small"
              onClick={() => onPreviewSize('small')}
            >
              Small
            </button>
            <button
              type="button"
              aria-pressed={previewSize === 'large'}
              data-testid="preview-size-large"
              onClick={() => onPreviewSize('large')}
            >
              Large
            </button>
          </div>
        )}
        <span className="spacer" />
        <button
          type="button"
          data-testid="preview-button"
          disabled={!canPreview || !!loadingState}
          title={canPreview ? 'Preview this image (Space)' : 'Select an image file to preview it'}
          onClick={() => openPreview(previewTarget)}
        >
          Preview
        </button>
        <button
          type="button"
          className="primary"
          data-testid="download-button"
          disabled={view.kind !== 'ready' || !!loadingState || selectedEntries.length === 0}
          title={
            selectedEntries.length > 0 && selectedFiles === 0
              ? 'Only regular files can be downloaded'
              : 'Download the selected files'
          }
          onClick={() => requestDownload(selectedEntries)}
        >
          Download{selectedFiles && !loadingState ? ` (${selectedFiles})` : ''}
        </button>
      </div>
      <div className="browser-body">{body}</div>
      {preview && (
        <PreviewDialog
          sessionId={session.sessionId}
          dir={preview.dir}
          images={preview.images}
          startIndex={preview.index}
          onClose={closePreview}
          onDownload={(path) => onDownload([path])}
        />
      )}
      <div className="browser-status" data-testid="browser-status">
        {view.kind === 'ready' && !loadingState && (
          <span data-testid="item-count">
            {query.trim()
              ? `${visible.length} of ${all.length - (showHidden ? 0 : hiddenCount)} items`
              : `${visible.length} item${visible.length === 1 ? '' : 's'}`}
            {!showHidden && hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
            {selection.selected.size > 0 ? ` · ${selection.selected.size} selected` : ''}
          </span>
        )}
        {message && (
          <span className="browser-message" data-testid="browser-message" role="status">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}

function ErrorState({
  view,
  session,
  b,
}: {
  view: { path: string; code: string; message: string; initial: boolean };
  session: BrowserSession;
  b: BrowserApi;
}): React.JSX.Element {
  const path = <span className="mono">{displayName(view.path)}</span>;
  const kind =
    view.code === 'REMOTE_PERMISSION_DENIED'
      ? 'denied'
      : view.code === 'REMOTE_NOT_FOUND'
        ? 'not-found'
        : view.code === 'DISCONNECTED'
          ? 'disconnected'
          : 'error';
  const title =
    kind === 'denied'
      ? 'Permission denied'
      : kind === 'not-found'
        ? 'Folder not found'
        : kind === 'disconnected'
          ? 'Not connected'
          : "Couldn't open this folder";
  const home = session.home;
  return (
    <div className="browser-state" data-testid={`browser-state-${kind}`} role="alert">
      <h2>{title}</h2>
      <p>
        {kind === 'denied' ? (
          <>The server doesn't allow your account to open {path}.</>
        ) : kind === 'not-found' ? (
          <>{path} doesn't exist on the server (or is not a folder).</>
        ) : (
          <>
            {path}: {view.message}
          </>
        )}
      </p>
      {view.initial && home && home !== view.path && (
        <p data-testid="initial-fallback">
          Your profile's start folder couldn't be opened.{' '}
          <button type="button" className="primary" onClick={() => b.navigate(home)}>
            Open server default folder
          </button>
        </p>
      )}
      <div className="state-actions">
        {canBack(b.history) && (
          <button type="button" onClick={b.back}>
            Go back
          </button>
        )}
        {view.path !== '/' && (
          <button type="button" onClick={() => b.navigate(parentOf(view.path))}>
            Open parent folder
          </button>
        )}
        <button type="button" onClick={b.refresh}>
          Try again
        </button>
      </div>
    </div>
  );
}
