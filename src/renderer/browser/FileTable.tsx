// Virtualized file table: only the rows in view (plus overscan) are in the
// DOM, so 10,000-entry folders stay fast (acceptance A14).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  formatModified,
  formatSize,
  isDirLike,
  typeLabel,
  type BrowseEntry,
  type Selection,
  type SortKey,
  type SortSpec,
} from '../../shared/browse';
import { displayName } from '../../shared/remote-path';
import { EntryIcon } from './icons';

export const ROW_HEIGHT = 28;
const OVERSCAN = 8;

export interface FileTableProps {
  entries: readonly BrowseEntry[];
  selection: Selection;
  sort: SortSpec;
  onSort(key: SortKey): void;
  onRowClick(index: number, e: React.MouseEvent): void;
  onRowOpen(index: number): void;
  onKeyDown(e: React.KeyboardEvent, pageSize: number): void;
  /** Changes when the folder changes so scroll resets. */
}

export function FileTable(p: FileTableProps): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Keep the keyboard cursor visible.
  const active = p.selection.active;
  useEffect(() => {
    const el = scroller.current;
    if (!el || active === null) return;
    const top = active * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight)
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [active]);

  const n = p.entries.length;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(n - 1, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const pageSize = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);

  const header = (key: SortKey, label: string, className: string): React.JSX.Element => {
    const on = p.sort.key === key;
    return (
      <div
        role="columnheader"
        className={className}
        aria-sort={on ? (p.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button type="button" className="sort-button" onClick={() => p.onSort(key)}>
          {label}
          <span aria-hidden="true" className="sort-arrow">
            {on ? (p.sort.direction === 'asc' ? '▲' : '▼') : ''}
          </span>
        </button>
      </div>
    );
  };

  const rows: React.JSX.Element[] = [];
  for (let i = first; i <= last; i++) {
    const e = p.entries[i]!;
    const selected = p.selection.selected.has(e.name);
    rows.push(
      <div
        key={e.name}
        id={`row-${i}`}
        role="row"
        aria-rowindex={i + 2}
        aria-selected={selected}
        data-testid="file-row"
        data-name={e.name}
        data-type={e.type}
        className={`file-row${selected ? ' selected' : ''}${active === i ? ' active' : ''}${isDirLike(e) ? ' dirlike' : ''}`}
        style={{ transform: `translateY(${i * ROW_HEIGHT}px)` }}
        onMouseDown={(ev) => {
          if (ev.shiftKey) ev.preventDefault(); // no text selection on shift-click
        }}
        onClick={(ev) => p.onRowClick(i, ev)}
        onDoubleClick={() => p.onRowOpen(i)}
      >
        <div role="gridcell" className="cell-name" title={displayName(e.name)}>
          <EntryIcon entry={e} />
          <span className="name-text">{displayName(e.name)}</span>
        </div>
        <div role="gridcell" className="cell-type">
          {typeLabel(e)}
        </div>
        <div
          role="gridcell"
          className="cell-size"
          title={e.size === null ? 'Unknown' : `${e.size} bytes`}
        >
          {formatSize(e.size)}
        </div>
        <div role="gridcell" className="cell-modified">
          {formatModified(e.modifiedTime)}
        </div>
      </div>,
    );
  }

  return (
    <div
      className="file-table"
      role="grid"
      aria-label="Files in this folder"
      aria-multiselectable="true"
      aria-rowcount={n + 1}
      aria-activedescendant={
        active !== null && active >= first && active <= last ? `row-${active}` : undefined
      }
      tabIndex={0}
      data-testid="file-table"
      onKeyDown={(ev) => p.onKeyDown(ev, pageSize)}
    >
      <div role="row" aria-rowindex={1} className="file-header">
        {header('name', 'Name', 'cell-name')}
        <div role="columnheader" className="cell-type">
          Type
        </div>
        {header('size', 'Size', 'cell-size')}
        {header('modified', 'Modified', 'cell-modified')}
      </div>
      <div
        className="file-scroller"
        ref={scroller}
        data-testid="file-scroller"
        onScroll={(ev) => setScrollTop(ev.currentTarget.scrollTop)}
      >
        <div className="file-rows" style={{ height: n * ROW_HEIGHT }}>
          {rows}
        </div>
      </div>
    </div>
  );
}
