// Destination handling on the local disk (spec 7.2). Electron-free.
//
// - The folder comes from a main-owned native dialog and is pinned by its
//   real path plus device/inode; it is re-verified before writing and before
//   finalizing, so a folder swapped for a symlink or another folder is caught.
// - Data goes to an exclusive (O_CREAT|O_EXCL), uniquely named .part file:
//   O_EXCL never follows an existing symlink.
// - A new file is promoted with link()+unlink(): link() fails with EEXIST if
//   anything (file, folder, symlink) took the name, so a concurrent creator is
//   never overwritten. Replacement uses rename() after checking that the file
//   being replaced is still the one the user approved; rename() replaces a
//   directory entry and never writes through a symlink.
import { randomBytes } from 'node:crypto';
import { link, lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { numberedName, type DownloadError, type DownloadErrorCode } from '../../shared/downloads';

export interface ApprovedDir {
  /** Real path (no symlinks) at approval time. */
  path: string;
  dev: string;
  ino: string;
}

export type TargetState =
  | { kind: 'absent' }
  | { kind: 'file'; id: string; size: string; mtimeNs: string }
  | { kind: 'notAFile' };

export class LocalFsError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
  toDownloadError(): DownloadError {
    return this.detail
      ? { code: this.code, message: this.message, detail: this.detail }
      : { code: this.code, message: this.message };
  }
}

/** Thrown at finalization when the destination is no longer what was approved. */
export class TargetChangedError extends Error {
  constructor(readonly now: TargetState) {
    super('destination changed');
  }
}

const errno = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? '';

const folderGone = (detail?: string): LocalFsError =>
  new LocalFsError(
    'DESTINATION_CHANGED',
    'The download folder changed or is no longer available.',
    detail,
  );

export async function approveDirectory(p: string): Promise<ApprovedDir> {
  if (!path.isAbsolute(p)) throw folderGone('not an absolute path');
  let real: string;
  try {
    real = await realpath(p);
  } catch (e) {
    throw classifyLocalError(e, 'the download folder');
  }
  const st = await lstat(real, { bigint: true });
  if (!st.isDirectory()) throw folderGone('not a folder');
  return { path: real, dev: String(st.dev), ino: String(st.ino) };
}

/** Throws DESTINATION_CHANGED if the approved folder moved or was replaced. */
export async function verifyDirectory(d: ApprovedDir): Promise<void> {
  try {
    const real = await realpath(d.path);
    const st = await lstat(d.path, { bigint: true });
    if (
      real !== d.path ||
      !st.isDirectory() ||
      String(st.dev) !== d.dev ||
      String(st.ino) !== d.ino
    )
      throw folderGone('folder was replaced');
  } catch (e) {
    if (e instanceof LocalFsError) throw e;
    throw folderGone(errno(e) || undefined);
  }
}

export async function inspectTarget(dir: ApprovedDir, name: string): Promise<TargetState> {
  try {
    const st = await lstat(path.join(dir.path, name), { bigint: true });
    if (!st.isFile()) return { kind: 'notAFile' };
    return {
      kind: 'file',
      id: `${st.dev}:${st.ino}`,
      size: String(st.size),
      mtimeNs: String(st.mtimeNs),
    };
  } catch (e) {
    if (errno(e) === 'ENOENT') return { kind: 'absent' };
    throw classifyLocalError(e, 'the download folder');
  }
}

export function sameTarget(a: TargetState, b: TargetState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'file' && b.kind === 'file')
    return a.id === b.id && a.size === b.size && a.mtimeNs === b.mtimeNs;
  return true;
}

/** Truncate to at most `max` UTF-8 bytes without splitting a code point. */
function truncateBytes(s: string, max: number): string {
  let out = s;
  while (Buffer.byteLength(out) > max) out = Array.from(out).slice(0, -1).join('');
  return out;
}

export const PART_SUFFIX = '.part';

export interface PartFile {
  fh: FileHandle;
  path: string;
  /** dev:ino of the part file, to recognise it later. */
  id: string;
}

/** Name for a new partial file next to `finalName`. Random, so never reused. */
export function partNameFor(finalName: string): string {
  return `${truncateBytes(finalName, 200)}.${randomBytes(4).toString('hex')}${PART_SUFFIX}`;
}

/**
 * Create the .part file exclusively. Afterwards confirm it really landed in
 * the approved folder (catches a folder swapped between check and open).
 */
export async function createPart(dir: ApprovedDir, partName: string): Promise<PartFile> {
  const p = path.join(dir.path, partName);
  let fh: FileHandle;
  try {
    fh = await open(p, 'wx');
  } catch (e) {
    throw classifyLocalError(e, 'the download folder');
  }
  try {
    const st = await fh.stat({ bigint: true });
    if ((await realpath(p)) !== p) throw folderGone('folder changed while creating the file');
    await verifyDirectory(dir);
    return { fh, path: p, id: `${st.dev}:${st.ino}` };
  } catch (e) {
    await fh.close().catch(() => undefined);
    await unlink(p).catch(() => undefined);
    throw e instanceof LocalFsError ? e : classifyLocalError(e, 'the download folder');
  }
}

async function isOurPart(part: string, id: string): Promise<boolean> {
  try {
    const st = await lstat(part, { bigint: true });
    return st.isFile() && `${st.dev}:${st.ino}` === id;
  } catch {
    return false;
  }
}

const finalizationFailed = (e: unknown, part: string): LocalFsError =>
  new LocalFsError(
    'FINALIZATION_FAILED',
    `The download finished but could not be saved under its final name. The data is kept in ${path.basename(part)}.`,
    errno(e) || (e as Error)?.message,
  );

/** Promote without replacing anything. Throws TargetChangedError on EEXIST. */
export async function promoteNew(part: PartFile, dir: ApprovedDir, name: string): Promise<string> {
  await verifyDirectory(dir);
  if (!(await isOurPart(part.path, part.id)))
    throw finalizationFailed(new Error('partial file was replaced'), part.path);
  const final = path.join(dir.path, name);
  try {
    await link(part.path, final);
  } catch (e) {
    const c = errno(e);
    if (c === 'EEXIST') throw new TargetChangedError(await inspectTarget(dir, name));
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EXDEV'].includes(c))
      throw finalizationFailed(e, part.path);
    // File systems without hard links (FAT, some network shares): claim the
    // name with an exclusive empty placeholder, then rename over our own
    // placeholder. A concurrent creator gets EEXIST instead of being replaced.
    try {
      await (await open(final, 'wx')).close();
    } catch (e2) {
      if (errno(e2) === 'EEXIST') throw new TargetChangedError(await inspectTarget(dir, name));
      throw finalizationFailed(e2, part.path);
    }
    try {
      await rename(part.path, final);
    } catch (e3) {
      await unlink(final).catch(() => undefined);
      throw finalizationFailed(e3, part.path);
    }
    return final;
  }
  await unlink(part.path).catch(() => undefined); // the final name already holds the data
  return final;
}

/** Replace the approved existing file. Throws TargetChangedError if it changed. */
export async function promoteReplace(
  part: PartFile,
  dir: ApprovedDir,
  name: string,
  approved: TargetState,
): Promise<string> {
  await verifyDirectory(dir);
  const now = await inspectTarget(dir, name);
  if (!sameTarget(now, approved)) throw new TargetChangedError(now);
  if (!(await isOurPart(part.path, part.id)))
    throw finalizationFailed(new Error('partial file was replaced'), part.path);
  const final = path.join(dir.path, name);
  try {
    await rename(part.path, final);
  } catch (e) {
    throw finalizationFailed(e, part.path);
  }
  return final;
}

/** Keep both: the original name if free, else the first free "name (n).ext". */
export async function promoteKeepBoth(
  part: PartFile,
  dir: ApprovedDir,
  name: string,
): Promise<string> {
  for (let n = 0; n < 10_000; n++) {
    const candidate = n === 0 ? name : numberedFits(name, n);
    try {
      return await promoteNew(part, dir, candidate);
    } catch (e) {
      if (!(e instanceof TargetChangedError)) throw e;
    }
  }
  throw finalizationFailed(new Error('no free numbered name'), part.path);
}

function numberedFits(name: string, n: number): string {
  let base = name;
  let candidate = numberedName(base, n);
  while (Buffer.byteLength(candidate) > 255 && base.length > 1) {
    base = Array.from(base).slice(0, -1).join('');
    candidate = numberedName(base, n);
  }
  return candidate;
}

/** Remove our partial file (only if it is still ours and a regular file). */
export async function removePart(partPath: string, id: string | null): Promise<void> {
  try {
    const st = await lstat(partPath, { bigint: true });
    if (!st.isFile()) return;
    if (id !== null && `${st.dev}:${st.ino}` !== id) return;
  } catch (e) {
    if (errno(e) === 'ENOENT') return;
    throw e;
  }
  await unlink(partPath);
}

/** Map a local filesystem error to a download error class (spec 10). */
export function classifyLocalError(e: unknown, what: string): LocalFsError {
  const c = errno(e);
  switch (c) {
    case 'ENOSPC':
    case 'EDQUOT':
      return new LocalFsError('DISK_FULL', 'The disk is full. Free some space and retry.', c);
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new LocalFsError(
        'LOCAL_PERMISSION_DENIED',
        `You don't have permission to write to ${what}.`,
        c,
      );
    case 'ENAMETOOLONG':
    case 'EILSEQ':
    case 'EINVAL':
      return new LocalFsError(
        'INVALID_FILENAME',
        'The file name cannot be used in the download folder.',
        c,
      );
    case 'ENOENT':
    case 'ENOTDIR':
    case 'ELOOP':
      return folderGone(c);
    default:
      return new LocalFsError(
        'LOCAL_ERROR',
        'The file could not be written.',
        c || (e as Error)?.message,
      );
  }
}
