// Destination primitives on the real local filesystem (temp directories).
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approveDirectory,
  classifyLocalError,
  createPart,
  inspectTarget,
  partNameFor,
  promoteKeepBoth,
  promoteNew,
  promoteReplace,
  removePart,
  TargetChangedError,
  verifyDirectory,
} from '../../src/main/downloads/local-fs';
import { useTempDir } from './helpers';

async function part(dirPath: string, name: string, data: string) {
  const dir = await approveDirectory(dirPath);
  const p = await createPart(dir, partNameFor(name));
  await p.fh.writeFile(data);
  await p.fh.close();
  return { dir, p };
}

describe('local destination handling', () => {
  const tmp = useTempDir();

  it('approves the real folder behind a symlink and notices when it is swapped', async () => {
    const root = await tmp();
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'link'));
    const d = await approveDirectory(join(root, 'link'));
    expect(d.path).toBe(join(root, 'real'));
    await verifyDirectory(d);
    await rename(join(root, 'real'), join(root, 'moved'));
    await mkdir(join(root, 'real'));
    await expect(verifyDirectory(d)).rejects.toMatchObject({ code: 'DESTINATION_CHANGED' });
    await expect(approveDirectory('relative/path')).rejects.toMatchObject({
      code: 'DESTINATION_CHANGED',
    });
  });

  it('creates partial files exclusively and never through a symlink', async () => {
    const root = await tmp();
    const d = await approveDirectory(root);
    await writeFile(join(root, 'outside.txt'), 'KEEP');
    await symlink(join(root, 'outside.txt'), join(root, 'trap.part'));
    await expect(createPart(d, 'trap.part')).rejects.toBeTruthy();
    expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('KEEP');
    expect(partNameFor('report.pdf')).toMatch(/^report\.pdf\.[0-9a-f]{8}\.part$/);
    expect(Buffer.byteLength(partNameFor('é'.repeat(127)))).toBeLessThanOrEqual(255);
  });

  it('promoteNew never replaces anything that took the name', async () => {
    const root = await tmp();
    const { dir, p } = await part(root, 'a.txt', 'NEW');
    await writeFile(join(root, 'a.txt'), 'OTHER');
    await expect(promoteNew(p, dir, 'a.txt')).rejects.toBeInstanceOf(TargetChangedError);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('OTHER');
    await symlink('/nonexistent/target', join(root, 'b.txt'));
    await expect(promoteNew(p, dir, 'b.txt')).rejects.toBeInstanceOf(TargetChangedError);
    expect(await promoteNew(p, dir, 'c.txt')).toBe(join(root, 'c.txt'));
    expect(await readFile(join(root, 'c.txt'), 'utf8')).toBe('NEW');
    expect((await readdir(root)).filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  it('promoteReplace replaces only the approved file', async () => {
    const root = await tmp();
    await writeFile(join(root, 'a.txt'), 'OLD');
    const { dir, p } = await part(root, 'a.txt', 'NEW');
    const approved = await inspectTarget(dir, 'a.txt');
    expect(approved.kind).toBe('file');
    await writeFile(join(root, 'a.txt'), 'EDITED'); // changed after approval
    await expect(promoteReplace(p, dir, 'a.txt', approved)).rejects.toBeInstanceOf(
      TargetChangedError,
    );
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('EDITED');
    const again = await inspectTarget(dir, 'a.txt');
    await promoteReplace(p, dir, 'a.txt', again);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('NEW');
  });

  it('Keep both takes the first free number and skips names taken by links or folders', async () => {
    const root = await tmp();
    await writeFile(join(root, 'r.pdf'), '0');
    await mkdir(join(root, 'r (1).pdf'));
    await symlink('/nowhere', join(root, 'r (2).pdf'));
    const { dir, p } = await part(root, 'r.pdf', 'NEW');
    expect(await promoteKeepBoth(p, dir, 'r.pdf')).toBe(join(root, 'r (3).pdf'));
    expect((await lstat(join(root, 'r (2).pdf'))).isSymbolicLink()).toBe(true);
  });

  it('refuses to promote a partial file that was swapped for another file', async () => {
    const root = await tmp();
    const { dir, p } = await part(root, 'a.txt', 'NEW');
    await rename(p.path, join(root, 'stolen'));
    await writeFile(p.path, 'IMPOSTOR');
    await expect(promoteNew(p, dir, 'a.txt')).rejects.toMatchObject({
      code: 'FINALIZATION_FAILED',
    });
    // Cleanup only removes our own file, identified by device and inode.
    await removePart(p.path, p.id);
    expect(await readFile(p.path, 'utf8')).toBe('IMPOSTOR');
    await link(join(root, 'stolen'), join(root, 'x.part'));
    await removePart(join(root, 'x.part'), p.id);
    await expect(lstat(join(root, 'x.part'))).rejects.toBeTruthy();
  });

  it('classifies local errors', () => {
    const e = (code: string) => Object.assign(new Error(code), { code });
    expect(classifyLocalError(e('ENOSPC'), 'x').code).toBe('DISK_FULL');
    expect(classifyLocalError(e('EDQUOT'), 'x').code).toBe('DISK_FULL');
    expect(classifyLocalError(e('EACCES'), 'x').code).toBe('LOCAL_PERMISSION_DENIED');
    expect(classifyLocalError(e('EROFS'), 'x').code).toBe('LOCAL_PERMISSION_DENIED');
    expect(classifyLocalError(e('ENAMETOOLONG'), 'x').code).toBe('INVALID_FILENAME');
    expect(classifyLocalError(e('ENOENT'), 'x').code).toBe('DESTINATION_CHANGED');
    expect(classifyLocalError(e('EIO'), 'x').code).toBe('LOCAL_ERROR');
  });
});
