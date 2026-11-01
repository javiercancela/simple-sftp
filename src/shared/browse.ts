// Pure browsing logic shared by main and renderer: listing DTOs, sorting,
// filtering, history, selection and stale-response tracking (spec 6).
import type { RemoteEntryType } from './transport-contract';

export interface BrowseEntry {
  name: string;
  type: RemoteEntryType;
  size: number | null;
  /** Unix epoch seconds. */
  modifiedTime: number | null;
  /** For symlinks: what the link resolves to ('broken' if it cannot be resolved). */
  linkTarget: 'directory' | 'file' | 'other' | 'broken' | null;
  /** False when the server sent a name we refuse to use as a path segment. */
  safeName: boolean;
}

export interface Listing {
  sessionId: string;
  requestId: string;
  path: string;
  entries: BrowseEntry[];
}

/** Directories and symlinks to directories sort first and navigate on open. */
export function isDirLike(e: BrowseEntry): boolean {
  return e.type === 'directory' || (e.type === 'symlink' && e.linkTarget === 'directory');
}

export const isHidden = (name: string): boolean => name.startsWith('.');

export type SortKey = 'name' | 'size' | 'modified';
export interface SortSpec {
  key: SortKey;
  direction: 'asc' | 'desc';
}
export const DEFAULT_SORT: SortSpec = { key: 'name', direction: 'asc' };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareNames(a: string, b: string): number {
  // Collation first, then code points so the order is total and stable.
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Unknown values go last whatever the direction. */
function compareNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
}

export function sortEntries(entries: readonly BrowseEntry[], spec: SortSpec): BrowseEntry[] {
  const dir = spec.direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const da = isDirLike(a);
    const db = isDirLike(b);
    if (da !== db) return da ? -1 : 1; // directories first, always
    let c = 0;
    if (spec.key === 'size') c = da ? 0 : compareNullable(a.size, b.size, dir);
    else if (spec.key === 'modified') c = compareNullable(a.modifiedTime, b.modifiedTime, dir);
    if (c !== 0) return c;
    return compareNames(a.name, b.name) * (spec.key === 'name' ? dir : 1);
  });
}

export interface FilterSpec {
  query: string;
  showHidden: boolean;
}

/** Current-directory name filter (case-insensitive substring); no server search. */
export function filterEntries(entries: readonly BrowseEntry[], f: FilterSpec): BrowseEntry[] {
  const q = f.query.trim().normalize('NFC').toLocaleLowerCase();
  return entries.filter(
    (e) =>
      (f.showHidden || !isHidden(e.name)) &&
      (q === '' || e.name.normalize('NFC').toLocaleLowerCase().includes(q)),
  );
}

// ---------- history ----------

export interface History {
  stack: string[];
  index: number;
}

export const emptyHistory = (): History => ({ stack: [], index: -1 });
export const currentOf = (h: History): string | null => h.stack[h.index] ?? null;
export const canBack = (h: History): boolean => h.index > 0;
export const canForward = (h: History): boolean => h.index < h.stack.length - 1;

/** Visit a new location: drops forward entries; no duplicate of the current one. */
export function pushHistory(h: History, path: string): History {
  if (currentOf(h) === path) return h;
  const stack = [...h.stack.slice(0, h.index + 1), path];
  return { stack, index: stack.length - 1 };
}

export function moveHistory(h: History, delta: -1 | 1): History {
  const index = h.index + delta;
  if (index < 0 || index >= h.stack.length) return h;
  return { stack: h.stack, index };
}

// ---------- stale responses ----------

/**
 * Tracks the single outstanding listing request. A response is applied only
 * if it answers the latest request of the current session; anything cancelled,
 * superseded or from another session is ignored (spec 6, 9.4).
 */
export class RequestTracker {
  private current: { sessionId: string; requestId: string } | null = null;

  begin(sessionId: string, requestId: string): void {
    this.current = { sessionId, requestId };
  }

  cancel(requestId?: string): void {
    if (!requestId || this.current?.requestId === requestId) this.current = null;
  }

  isCurrent(sessionId: string, requestId: string): boolean {
    return this.current?.sessionId === sessionId && this.current.requestId === requestId;
  }

  /** True once: consumes the request when it is current. */
  settle(sessionId: string, requestId: string): boolean {
    if (!this.isCurrent(sessionId, requestId)) return false;
    this.current = null;
    return true;
  }

  get pending(): { sessionId: string; requestId: string } | null {
    return this.current;
  }
}

// ---------- selection ----------

export interface Selection {
  selected: ReadonlySet<string>;
  /** Index (in the visible list) of the keyboard cursor. */
  active: number | null;
  /** Range anchor for Shift selection. */
  anchor: number | null;
}

export const emptySelection = (): Selection => ({
  selected: new Set(),
  active: null,
  anchor: null,
});

function range(names: readonly string[], a: number, b: number): Set<string> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return new Set(names.slice(lo, hi + 1));
}

export interface Modifiers {
  shift?: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  toggle?: boolean;
}

export function clickSelect(
  sel: Selection,
  names: readonly string[],
  index: number,
  m: Modifiers = {},
): Selection {
  const name = names[index];
  if (name === undefined) return sel;
  if (m.shift) {
    const anchor = sel.anchor ?? index;
    const r = range(names, anchor, index);
    if (m.toggle) for (const n of sel.selected) r.add(n);
    return { selected: r, active: index, anchor };
  }
  if (m.toggle) {
    const s = new Set(sel.selected);
    if (s.has(name)) s.delete(name);
    else s.add(name);
    return { selected: s, active: index, anchor: index };
  }
  return { selected: new Set([name]), active: index, anchor: index };
}

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';
export type GridNavKey = NavKey | 'ArrowLeft' | 'ArrowRight';

/** Standard list keyboard behaviour; `toggle` moves the cursor without selecting. */
export function keySelect(
  sel: Selection,
  names: readonly string[],
  key: NavKey,
  m: Modifiers = {},
  pageSize = 10,
): Selection {
  if (names.length === 0) return sel;
  const last = names.length - 1;
  const cur = sel.active ?? -1;
  const target = Math.max(
    0,
    Math.min(
      last,
      key === 'ArrowUp'
        ? cur < 0
          ? 0
          : cur - 1
        : key === 'ArrowDown'
          ? cur + 1
          : key === 'Home'
            ? 0
            : key === 'End'
              ? last
              : key === 'PageUp'
                ? cur - pageSize
                : cur + pageSize,
    ),
  );
  if (m.shift) {
    const anchor = sel.anchor ?? (cur < 0 ? target : cur);
    return { selected: range(names, anchor, target), active: target, anchor };
  }
  if (m.toggle) return { ...sel, active: target };
  return { selected: new Set([names[target]!]), active: target, anchor: target };
}

/**
 * Keyboard cursor for the preview grid. Left/right move by one tile, up/down
 * by a row (`columns`). Same shift and toggle rules as the list.
 */
export function gridKeySelect(
  sel: Selection,
  names: readonly string[],
  key: GridNavKey,
  columns: number,
  m: Modifiers = {},
  pageRows = 3,
): Selection {
  if (names.length === 0) return sel;
  const cols = Math.max(1, Math.floor(columns));
  const last = names.length - 1;
  const cur = sel.active ?? -1;
  const raw =
    key === 'ArrowLeft'
      ? cur < 0
        ? 0
        : cur - 1
      : key === 'ArrowRight'
        ? cur + 1
        : key === 'ArrowUp'
          ? cur < 0
            ? 0
            : cur - cols
          : key === 'ArrowDown'
            ? cur < 0
              ? 0
              : cur + cols
            : key === 'Home'
              ? 0
              : key === 'End'
                ? last
                : key === 'PageUp'
                  ? cur - pageRows * cols
                  : cur + pageRows * cols;
  const target = Math.max(0, Math.min(last, raw));
  if (m.shift) {
    const anchor = sel.anchor ?? (cur < 0 ? target : cur);
    return { selected: range(names, anchor, target), active: target, anchor };
  }
  if (m.toggle) return { ...sel, active: target };
  return { selected: new Set([names[target]!]), active: target, anchor: target };
}

export function selectAll(names: readonly string[], sel: Selection): Selection {
  return {
    selected: new Set(names),
    active: sel.active ?? (names.length ? 0 : null),
    anchor: sel.anchor,
  };
}

/** Space with the toggle modifier: flip the active row. */
export function toggleActive(sel: Selection, names: readonly string[]): Selection {
  if (sel.active === null) return sel;
  return clickSelect(sel, names, sel.active, { toggle: true });
}

/** Keep only names still visible; re-point the cursor. */
export function reconcileSelection(sel: Selection, names: readonly string[]): Selection {
  const visible = new Set(names);
  const selected = new Set([...sel.selected].filter((n) => visible.has(n)));
  const clamp = (i: number | null): number | null =>
    i === null || names.length === 0 ? null : Math.min(i, names.length - 1);
  return { selected, active: clamp(sel.active), anchor: clamp(sel.anchor) };
}

// ---------- formatting ----------

export const UNKNOWN = '\u2014'; // em dash for unknown metadata (spec 6)

export function formatSize(bytes: number | null): string {
  if (bytes === null) return UNKNOWN;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatModified(epochSeconds: number | null, locale?: string): string {
  if (epochSeconds === null) return UNKNOWN;
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function typeLabel(e: BrowseEntry): string {
  switch (e.type) {
    case 'directory':
      return 'Folder';
    case 'file':
      return 'File';
    case 'symlink':
      return e.linkTarget === 'directory'
        ? 'Link to folder'
        : e.linkTarget === 'file'
          ? 'Link to file'
          : e.linkTarget === 'broken'
            ? 'Broken link'
            : 'Link';
    default:
      return 'Other';
  }
}
