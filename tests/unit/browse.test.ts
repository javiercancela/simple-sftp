import { describe, expect, it } from 'vitest';
import {
  RequestTracker,
  canBack,
  canForward,
  clickSelect,
  currentOf,
  emptyHistory,
  emptySelection,
  filterEntries,
  formatModified,
  formatSize,
  gridKeySelect,
  keySelect,
  moveHistory,
  pushHistory,
  reconcileSelection,
  selectAll,
  sortEntries,
  toggleActive,
  typeLabel,
  type BrowseEntry,
} from '../../src/shared/browse';

const f = (name: string, size: number | null = 1, mtime: number | null = 100): BrowseEntry => ({
  name,
  type: 'file',
  size,
  modifiedTime: mtime,
  linkTarget: null,
  safeName: true,
});
const d = (name: string, mtime: number | null = 100): BrowseEntry => ({
  name,
  type: 'directory',
  size: null,
  modifiedTime: mtime,
  linkTarget: null,
  safeName: true,
});
const l = (name: string, target: BrowseEntry['linkTarget']): BrowseEntry => ({
  name,
  type: 'symlink',
  size: null,
  modifiedTime: 50,
  linkTarget: target,
  safeName: true,
});
const names = (es: BrowseEntry[]): string[] => es.map((e) => e.name);

describe('sorting', () => {
  const entries = [
    f('b.txt', 30, 300),
    d('zeta', 10),
    f('A.txt', 10, 100),
    l('link-dir', 'directory'),
    f('file10', 20, null),
    f('file2', null, 200),
    d('alpha', 20),
    l('link-file', 'file'),
  ];

  it('default: directories (incl. links to folders) first, then natural, case-insensitive names', () => {
    expect(names(sortEntries(entries, { key: 'name', direction: 'asc' }))).toEqual([
      'alpha',
      'link-dir',
      'zeta',
      'A.txt',
      'b.txt',
      'file2',
      'file10',
      'link-file',
    ]);
  });

  it('name descending keeps directories first', () => {
    expect(names(sortEntries(entries, { key: 'name', direction: 'desc' }))).toEqual([
      'zeta',
      'link-dir',
      'alpha',
      'link-file',
      'file10',
      'file2',
      'b.txt',
      'A.txt',
    ]);
  });

  it('size: unknown sizes last in both directions; directories by name', () => {
    const asc = names(sortEntries(entries, { key: 'size', direction: 'asc' }));
    expect(asc.slice(0, 3)).toEqual(['alpha', 'link-dir', 'zeta']);
    expect(asc.slice(3)).toEqual(['A.txt', 'file10', 'b.txt', 'file2', 'link-file']);
    const desc = names(sortEntries(entries, { key: 'size', direction: 'desc' }));
    expect(desc.slice(3)).toEqual(['b.txt', 'file10', 'A.txt', 'file2', 'link-file']);
  });

  it('modified: unknown times last', () => {
    const asc = names(sortEntries(entries, { key: 'modified', direction: 'asc' }));
    expect(asc).toEqual([
      'zeta',
      'alpha',
      'link-dir',
      'link-file',
      'A.txt',
      'file2',
      'b.txt',
      'file10',
    ]);
    const desc = names(sortEntries(entries, { key: 'modified', direction: 'desc' }));
    expect(desc.at(-1)).toBe('file10');
  });

  it('is total and deterministic for names equal under collation', () => {
    const a = names(sortEntries([f('a'), f('A'), f('á')], { key: 'name', direction: 'asc' }));
    const b = names(sortEntries([f('á'), f('A'), f('a')], { key: 'name', direction: 'asc' }));
    expect(a).toEqual(b);
  });

  it('does not mutate its input', () => {
    const copy = [...entries];
    sortEntries(entries, { key: 'size', direction: 'desc' });
    expect(entries).toEqual(copy);
  });

  it('sorts 10,000 entries quickly', () => {
    const big = Array.from({ length: 10_000 }, (_, i) =>
      f(`file-${(i * 7919) % 10_000}.dat`, i, i),
    );
    const t0 = performance.now();
    const s = sortEntries(big, { key: 'name', direction: 'asc' });
    const ms = performance.now() - t0;
    expect(s[0]!.name).toBe('file-0.dat');
    expect(s[9999]!.name).toBe('file-9999.dat');
    expect(ms).toBeLessThan(500);
  });
});

describe('filtering', () => {
  const entries = [
    f('.env'),
    d('.git'),
    f('Report Q1.pdf'),
    f('report-q2.PDF'),
    f('Ünïcødé.txt'),
    d('reports'),
  ];

  it('hides dot files unless Show hidden files is on', () => {
    expect(names(filterEntries(entries, { query: '', showHidden: false }))).toEqual([
      'Report Q1.pdf',
      'report-q2.PDF',
      'Ünïcødé.txt',
      'reports',
    ]);
    expect(filterEntries(entries, { query: '', showHidden: true })).toHaveLength(6);
  });

  it('case-insensitive substring in the current folder only', () => {
    expect(names(filterEntries(entries, { query: 'REPORT', showHidden: false }))).toEqual([
      'Report Q1.pdf',
      'report-q2.PDF',
      'reports',
    ]);
    expect(names(filterEntries(entries, { query: ' .pdf ', showHidden: false }))).toHaveLength(2);
    expect(names(filterEntries(entries, { query: 'git', showHidden: false }))).toEqual([]);
    expect(names(filterEntries(entries, { query: 'git', showHidden: true }))).toEqual(['.git']);
  });

  it('matches regardless of Unicode normalization form', () => {
    const nfd = 'Ünïcødé'.normalize('NFD');
    expect(names(filterEntries(entries, { query: nfd, showHidden: false }))).toEqual([
      'Ünïcødé.txt',
    ]);
  });
});

describe('history', () => {
  it('push, back, forward, and push after back drops forward entries', () => {
    let h = emptyHistory();
    expect(canBack(h)).toBe(false);
    h = pushHistory(h, '/a');
    h = pushHistory(h, '/a/b');
    h = pushHistory(h, '/a/b'); // same as current: no duplicate
    h = pushHistory(h, '/a/b/c');
    expect(h.stack).toEqual(['/a', '/a/b', '/a/b/c']);
    h = moveHistory(h, -1);
    h = moveHistory(h, -1);
    expect(currentOf(h)).toBe('/a');
    expect(canBack(h)).toBe(false);
    expect(canForward(h)).toBe(true);
    expect(moveHistory(h, -1)).toBe(h);
    h = moveHistory(h, 1);
    expect(currentOf(h)).toBe('/a/b');
    h = pushHistory(h, '/x');
    expect(h.stack).toEqual(['/a', '/a/b', '/x']);
    expect(canForward(h)).toBe(false);
  });
});

describe('stale responses', () => {
  it('only the latest request of the current session is applied, once', () => {
    const t = new RequestTracker();
    t.begin('s1', 'r1');
    t.begin('s1', 'r2'); // supersedes r1
    expect(t.settle('s1', 'r1')).toBe(false);
    expect(t.settle('s2', 'r2')).toBe(false); // wrong session
    expect(t.settle('s1', 'r2')).toBe(true);
    expect(t.settle('s1', 'r2')).toBe(false); // already applied
  });

  it('cancelled requests are ignored when they finally answer', () => {
    const t = new RequestTracker();
    t.begin('s1', 'r1');
    t.cancel('other'); // cancelling something else does nothing
    expect(t.isCurrent('s1', 'r1')).toBe(true);
    t.cancel('r1');
    expect(t.settle('s1', 'r1')).toBe(false);
    expect(t.pending).toBeNull();
  });

  it('out-of-order replies: a late older reply after a newer one is dropped', () => {
    const t = new RequestTracker();
    const applied: string[] = [];
    t.begin('s', 'old');
    t.begin('s', 'new');
    for (const r of ['new', 'old']) if (t.settle('s', r)) applied.push(r);
    expect(applied).toEqual(['new']);
  });
});

describe('selection', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];

  it('click selects one; toggle adds/removes; shift selects a range from the anchor', () => {
    let s = clickSelect(emptySelection(), list, 1);
    expect([...s.selected]).toEqual(['b']);
    s = clickSelect(s, list, 3, { toggle: true });
    expect([...s.selected].sort()).toEqual(['b', 'd']);
    s = clickSelect(s, list, 3, { toggle: true });
    expect([...s.selected]).toEqual(['b']);
    s = clickSelect(clickSelect(emptySelection(), list, 1), list, 3, { shift: true });
    expect([...s.selected]).toEqual(['b', 'c', 'd']);
    s = clickSelect(s, list, 0, { shift: true }); // same anchor, new range
    expect([...s.selected]).toEqual(['a', 'b']);
  });

  it('arrows move and select; shift extends; toggle moves cursor only; Home/End/Page', () => {
    let s = keySelect(emptySelection(), list, 'ArrowDown');
    expect(s.active).toBe(0);
    s = keySelect(s, list, 'ArrowDown');
    expect([...s.selected]).toEqual(['b']);
    s = keySelect(s, list, 'ArrowDown', { shift: true });
    s = keySelect(s, list, 'ArrowDown', { shift: true });
    expect([...s.selected]).toEqual(['b', 'c', 'd']);
    s = keySelect(s, list, 'ArrowUp', { toggle: true });
    expect(s.active).toBe(2);
    expect(s.selected.size).toBe(3);
    s = toggleActive(s, list);
    expect([...s.selected].sort()).toEqual(['b', 'd']);
    expect(keySelect(s, list, 'End').active).toBe(4);
    expect(keySelect(s, list, 'Home').active).toBe(0);
    expect(keySelect(s, list, 'PageDown', {}, 10).active).toBe(4);
    expect(keySelect(keySelect(s, list, 'End'), list, 'PageUp', {}, 2).active).toBe(2);
    expect(keySelect(emptySelection(), [], 'ArrowDown')).toEqual(emptySelection());
  });

  it('grid arrows move by column; left and right move by one', () => {
    const tiles = ['a', 'b', 'c', 'd', 'e', 'f'];
    let s = gridKeySelect(emptySelection(), tiles, 'ArrowRight', 3);
    expect(s.active).toBe(0);
    s = gridKeySelect(s, tiles, 'ArrowRight', 3);
    expect([...s.selected]).toEqual(['b']);
    s = gridKeySelect(s, tiles, 'ArrowDown', 3);
    expect([...s.selected]).toEqual(['e']);
    s = gridKeySelect(s, tiles, 'ArrowLeft', 3, { shift: true });
    expect([...s.selected].sort()).toEqual(['d', 'e']);
    s = gridKeySelect(s, tiles, 'Home', 3, { toggle: true });
    expect(s.active).toBe(0);
    expect(s.selected.size).toBe(2);
    expect(gridKeySelect(s, tiles, 'End', 3).active).toBe(5);
    expect(gridKeySelect(emptySelection(), [], 'ArrowDown', 4)).toEqual(emptySelection());
  });

  it('select all and reconcile after filtering', () => {
    const s = selectAll(list, emptySelection());
    expect(s.selected.size).toBe(5);
    const r = reconcileSelection({ ...s, active: 4 }, ['a', 'c']);
    expect([...r.selected]).toEqual(['a', 'c']);
    expect(r.active).toBe(1);
  });
});

describe('formatting', () => {
  it('unknown metadata is an em dash, never zero', () => {
    expect(formatSize(null)).toBe('\u2014');
    expect(formatModified(null)).toBe('\u2014');
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1536)).toBe('1.5 KiB');
    expect(formatSize(5 * 1024 ** 3)).toBe('5.0 GiB');
    expect(formatModified(0, 'en-US')).not.toBe('\u2014');
  });

  it('type labels distinguish links', () => {
    expect(typeLabel({ ...f('x'), type: 'symlink', linkTarget: 'directory' })).toBe(
      'Link to folder',
    );
    expect(typeLabel({ ...f('x'), type: 'symlink', linkTarget: 'broken' })).toBe('Broken link');
  });
});
