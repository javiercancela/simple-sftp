// App-owned record of partial files (spec 7.3, 10). Only files listed here
// are ever offered for cleanup; unrelated .part files are never touched.
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { VersionedJsonFile, type Recovery } from '../platform/json-file';
import { PART_SUFFIX, removePart } from './local-fs';

const EntrySchema = z
  .object({
    jobId: z.uuid(),
    partPath: z.string().min(1).max(8192),
    /** dev:ino of the part file once created; null until then. */
    partId: z.string().max(200).nullable(),
    finalPath: z.string().min(1).max(8192),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type JournalEntry = z.infer<typeof EntrySchema>;

const JournalSchema = z
  .object({ version: z.literal(1), entries: z.array(EntrySchema).max(10_000) })
  .strict();

export interface OrphanPartial {
  jobId: string;
  partPath: string;
  finalPath: string;
  size: number;
}

export class TransferJournal {
  private readonly file: VersionedJsonFile<typeof JournalSchema>;
  private entries: JournalEntry[] = [];
  recovered: Recovery | null = null;

  constructor(dir: string) {
    this.file = new VersionedJsonFile(
      path.join(dir, 'transfer-journal.json'),
      JournalSchema,
      () => ({
        version: 1 as const,
        entries: [],
      }),
    );
  }

  async load(): Promise<void> {
    const r = await this.file.load();
    this.entries = r.data.entries;
    this.recovered = r.recovered;
  }

  list(): JournalEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  async add(entry: JournalEntry): Promise<void> {
    this.entries = [...this.entries.filter((e) => e.jobId !== entry.jobId), entry];
    await this.save();
  }

  async setPartId(jobId: string, partId: string): Promise<void> {
    this.entries = this.entries.map((e) => (e.jobId === jobId ? { ...e, partId } : e));
    await this.save();
  }

  async remove(jobId: string): Promise<void> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.jobId !== jobId);
    if (this.entries.length !== before) await this.save();
  }

  private save(): Promise<void> {
    return this.file.save({ version: 1, entries: this.entries });
  }

  /**
   * Partial files left by a previous run. Entries whose file is gone (or is no
   * longer a regular file, or no longer the file we created) are dropped.
   */
  async findOrphans(): Promise<OrphanPartial[]> {
    const found: OrphanPartial[] = [];
    const keep: JournalEntry[] = [];
    for (const e of this.entries) {
      if (!e.partPath.endsWith(PART_SUFFIX)) continue;
      try {
        const st = await lstat(e.partPath, { bigint: true });
        if (!st.isFile()) continue;
        if (e.partId !== null && `${st.dev}:${st.ino}` !== e.partId) continue;
        found.push({
          jobId: e.jobId,
          partPath: e.partPath,
          finalPath: e.finalPath,
          size: Number(st.size),
        });
        keep.push(e);
      } catch {
        /* gone */
      }
    }
    if (keep.length !== this.entries.length) {
      this.entries = keep;
      await this.save();
    }
    return found;
  }

  /**
   * Delete the given orphans (journal entries found at startup, never the
   * entries of running jobs), or just forget them.
   */
  async resolveOrphans(
    jobIds: ReadonlySet<string>,
    action: 'delete' | 'keep',
  ): Promise<{ failed: string[] }> {
    const failed: string[] = [];
    const targets = this.entries.filter((e) => jobIds.has(e.jobId));
    if (action === 'delete') {
      for (const e of targets) {
        try {
          await removePart(e.partPath, e.partId);
        } catch {
          failed.push(e.partPath);
        }
      }
    }
    this.entries = this.entries.filter((e) => !jobIds.has(e.jobId) || failed.includes(e.partPath));
    await this.save();
    return { failed };
  }
}
