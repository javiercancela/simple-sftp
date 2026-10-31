// Preview-mode grid. Only the tiles in view (plus a little overscan) are
// mounted, and only image files among those request a thumbnail. Scrolling a
// tile out, changing folder, or disconnecting unmounts it, which cancels the
// request. Non-images are an icon and a name.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isDirLike, type BrowseEntry, type Selection } from '../../shared/browse';
import { isPreviewable, TILE_PX, tileWindow } from '../../shared/preview';
import type { PreviewSize } from '../../shared/settings';
import { displayName, joinRemote } from '../../shared/remote-path';
import { api } from '../api';
import { EntryIcon } from './icons';

const OVERSCAN_ROWS = 2;

export function PreviewGrid(p: {
  entries: readonly BrowseEntry[];
  selection: Selection;
  dir: string;
  sessionId: string;
  size: PreviewSize;
  onRowClick(index: number, e: React.MouseEvent): void;
  onRowOpen(index: number): void;
  onKeyDown(e: React.KeyboardEvent, columns: number, pageRows: number): void;
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [box, setBox] = useState({ width: 0, height: 400 });
  const tile = TILE_PX[p.size];

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = (): void => setBox({ width: el.clientWidth, height: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const columns = Math.max(1, Math.floor(box.width / tile) || 1);
  const pageRows = Math.max(1, Math.floor(box.height / tile));
  const windowed = tileWindow({
    count: p.entries.length,
    scrollTop,
    viewport: box.height,
    columns,
    tile,
    overscanRows: OVERSCAN_ROWS,
  });

  const active = p.selection.active;
  useEffect(() => {
    const el = scroller.current;
    if (!el || active === null) return;
    const row = Math.floor(active / columns);
    const top = row * tile;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + tile > el.scrollTop + el.clientHeight)
      el.scrollTop = top + tile - el.clientHeight;
  }, [active, columns, tile]);

  const tiles: React.JSX.Element[] = [];
  for (let i = windowed.first; i <= windowed.last; i++) {
    const e = p.entries[i];
    if (!e) continue;
    const col = i % columns;
    const row = Math.floor(i / columns);
    const selected = p.selection.selected.has(e.name);
    tiles.push(
      <div
        key={e.name}
        id={`tile-${i}`}
        role="gridcell"
        aria-selected={selected}
        aria-label={displayName(e.name)}
        data-testid="preview-tile"
        data-name={e.name}
        data-type={e.type}
        title={displayName(e.name)}
        className={`preview-tile${selected ? ' selected' : ''}${active === i ? ' active' : ''}${isDirLike(e) ? ' dirlike' : ''}`}
        style={{
          transform: `translate(${col * tile}px, ${row * tile}px)`,
          width: tile,
          height: tile,
        }}
        onMouseDown={(ev) => {
          if (ev.shiftKey) ev.preventDefault();
        }}
        onClick={(ev) => p.onRowClick(i, ev)}
        onDoubleClick={() => p.onRowOpen(i)}
      >
        <div className="thumb">
          {isPreviewable(e) ? (
            <Thumb
              key={`${p.size}:${e.name}`}
              sessionId={p.sessionId}
              path={joinRemote(p.dir, e.name)}
              size={p.size}
              entry={e}
            />
          ) : (
            <span className="tile-icon" data-thumb="icon">
              <EntryIcon entry={e} />
            </span>
          )}
        </div>
        <span className="tile-name">{displayName(e.name)}</span>
      </div>,
    );
  }

  return (
    <div
      className="preview-grid"
      role="grid"
      aria-label="Files in this folder"
      aria-multiselectable="true"
      aria-rowcount={Math.ceil(p.entries.length / columns)}
      aria-colcount={columns}
      aria-activedescendant={
        active !== null && active >= windowed.first && active <= windowed.last
          ? `tile-${active}`
          : undefined
      }
      tabIndex={0}
      data-testid="preview-grid"
      data-size={p.size}
      style={{ ['--tile' as string]: `${tile}px` }}
      onKeyDown={(ev) => p.onKeyDown(ev, columns, pageRows)}
    >
      <div
        className="preview-scroller"
        ref={scroller}
        data-testid="preview-scroller"
        onScroll={(ev) => setScrollTop(ev.currentTarget.scrollTop)}
      >
        <div className="preview-tiles" style={{ height: windowed.height }}>
          {tiles}
        </div>
      </div>
    </div>
  );
}

function Thumb({
  sessionId,
  path,
  size,
  entry,
}: {
  sessionId: string;
  path: string;
  size: PreviewSize;
  entry: BrowseEntry;
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const requestId = crypto.randomUUID();
    const holder = { url: null as string | null, alive: true };
    void api()
      .remote.thumbnail(sessionId, requestId, path, size)
      .then((r) => {
        if (!holder.alive) return;
        if (
          !r.ok ||
          r.value.requestId !== requestId ||
          !r.value.mime ||
          r.value.bytes.byteLength === 0
        ) {
          setFailed(true);
          return;
        }
        holder.url = URL.createObjectURL(new Blob([r.value.bytes], { type: r.value.mime }));
        setSrc(holder.url);
      });
    return () => {
      holder.alive = false;
      void api().remote.cancelThumbnail(sessionId, requestId);
      if (holder.url) URL.revokeObjectURL(holder.url);
    };
  }, [sessionId, path, size]);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        data-testid="thumb-image"
        data-thumb="image"
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="tile-icon" data-thumb={src ? 'icon' : failed ? 'icon' : 'loading'}>
      <EntryIcon entry={entry} />
    </span>
  );
}
