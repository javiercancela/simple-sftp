// POSIX remote path helpers (spec 6: remote paths use POSIX semantics on every
// local OS). Pure; no Node `path` (which would be win32 on Windows).

export const MAX_REMOTE_PATH = 4096;

/** Absolute, normalized POSIX path: collapses //, resolves . and .., no trailing slash. */
export function normalizeRemotePath(p: string): string {
  if (!p.startsWith('/')) throw new Error('Remote path must be absolute');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

/**
 * Resolve what the user typed in the location field against the current
 * folder. Returns null for input that cannot be a remote path.
 */
export function resolveLocationInput(input: string, current: string): string | null {
  const v = input.trim();
  if (v === '' || v.length > MAX_REMOTE_PATH || v.includes('\0')) return null;
  return normalizeRemotePath(v.startsWith('/') ? v : `${current}/${v}`);
}

/** A name the server returned that we can safely join as one path segment. */
export function isSafeEntryName(name: string): boolean {
  return (
    name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
  );
}

export function joinRemote(dir: string, name: string): string {
  if (!isSafeEntryName(name)) throw new Error('Unsafe entry name');
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentOf(p: string): string {
  const n = normalizeRemotePath(p);
  if (n === '/') return '/';
  return n.slice(0, n.lastIndexOf('/')) || '/';
}

export interface Crumb {
  label: string;
  path: string;
}

export function breadcrumbs(p: string): Crumb[] {
  const n = normalizeRemotePath(p);
  const crumbs: Crumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const seg of n.split('/').filter(Boolean)) {
    acc += `/${seg}`;
    crumbs.push({ label: seg, path: acc });
  }
  return crumbs;
}

/**
 * Display form of a remote name: control characters become visible Unicode
 * "control pictures" so names like "a\nb" can't break the layout. Always
 * rendered as text, never HTML.
 */
export function displayName(name: string): string {
  let out = '';
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20) out += String.fromCodePoint(0x2400 + c);
    else if (c === 0x7f) out += '\u2421';
    else out += ch;
  }
  return out;
}
