// Versioned JSON persistence with atomic writes and corrupt-file recovery
// (spec 10). Electron-free so it can be tested directly.
import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';

export interface Recovery {
  backupPath: string;
  reason: string;
}

export interface LoadResult<T> {
  data: T;
  /** Set when the file existed but was unreadable/invalid and was set aside. */
  recovered: Recovery | null;
}

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Write JSON atomically: exclusive temp file, fsync, rename over target. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await fh.sync();
  } catch (err) {
    await fh.close();
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fh.close();
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fsyncDir(dir).catch(() => undefined);
}

export class VersionedJsonFile<S extends z.ZodType> {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly schema: S,
    private readonly makeDefault: () => z.infer<S>,
  ) {}

  /**
   * Load and validate. A missing file yields defaults. A corrupt, invalid or
   * future-version file is preserved under a timestamped backup name and
   * defaults are returned with a recovery notice — never silently discarded.
   */
  async load(): Promise<LoadResult<z.infer<S>>> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { data: this.makeDefault(), recovered: null };
      }
      throw err;
    }
    let reason: string;
    try {
      const parsed = this.schema.safeParse(JSON.parse(text));
      if (parsed.success) return { data: parsed.data, recovered: null };
      reason = `invalid content: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`;
    } catch (err) {
      reason = `not valid JSON: ${(err as Error).message}`;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${this.file}.corrupt-${stamp}`;
    await rename(this.file, backupPath);
    return { data: this.makeDefault(), recovered: { backupPath, reason } };
  }

  /** Serialized atomic save; validates before writing. */
  save(value: z.infer<S>): Promise<void> {
    const valid = this.schema.parse(value);
    const next = this.chain.then(() => writeJsonAtomic(this.file, valid));
    this.chain = next.catch(() => undefined);
    return next;
  }
}
