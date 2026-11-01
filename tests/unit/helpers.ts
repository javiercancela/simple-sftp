import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

/** Fresh temp dir per test, removed afterwards. */
export function useTempDir(): () => Promise<string> {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  return async () => {
    // Canonicalize. On macOS os.tmpdir() is /var/folders, a symlink to
    // /private/var/folders, and approveDirectory() stores the real path.
    const d = await realpath(await mkdtemp(join(tmpdir(), 'sftp-unit-')));
    dirs.push(d);
    return d;
  };
}
