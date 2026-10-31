import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  PROFILES_FILE_VERSION,
  ProfileInputSchema,
  ProfilesFileSchema,
  type Profile,
  type ProfilesFile,
} from '../../shared/profiles';
import { VersionedJsonFile, type Recovery } from '../platform/json-file';

export class ProfileValidationError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('Profile is invalid');
  }
}

export class ProfileNotFoundError extends Error {
  constructor() {
    super('Profile not found');
  }
}

function checkLocalPaths(
  p: Pick<Profile, 'privateKeyPath' | 'certificatePath' | 'downloadDirectory'>,
): void {
  // Main-side check with the real platform rules.
  const fields: Record<string, string> = {};
  if (!path.isAbsolute(p.privateKeyPath)) fields.privateKeyPath = 'Must be an absolute path';
  if (p.certificatePath && !path.isAbsolute(p.certificatePath))
    fields.certificatePath = 'Must be an absolute path';
  if (p.downloadDirectory && !path.isAbsolute(p.downloadDirectory))
    fields.downloadDirectory = 'Must be an absolute path';
  if (Object.keys(fields).length) throw new ProfileValidationError(fields);
}

export class ProfileStore {
  private readonly file: VersionedJsonFile<typeof ProfilesFileSchema>;
  private data: ProfilesFile = { version: PROFILES_FILE_VERSION, profiles: [] };
  recovered: Recovery | null = null;

  constructor(
    dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = new VersionedJsonFile(path.join(dir, 'profiles.json'), ProfilesFileSchema, () => ({
      version: PROFILES_FILE_VERSION,
      profiles: [],
    }));
  }

  async load(): Promise<void> {
    const r = await this.file.load();
    this.data = r.data;
    this.recovered = r.recovered;
  }

  list(): Profile[] {
    return this.data.profiles.map((p) => ({ ...p }));
  }

  get(id: string): Profile | undefined {
    const p = this.data.profiles.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }

  private async commit(profiles: Profile[]): Promise<void> {
    const next: ProfilesFile = { version: PROFILES_FILE_VERSION, profiles };
    await this.file.save(next);
    this.data = next;
  }

  /** Create (no id) or update (existing id). */
  async save(id: string | undefined, input: unknown): Promise<Profile> {
    const parsed = ProfileInputSchema.safeParse(input);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const i of parsed.error.issues) fields[String(i.path[0] ?? 'form')] ??= i.message;
      throw new ProfileValidationError(fields);
    }
    checkLocalPaths(parsed.data);
    const ts = this.now().toISOString();
    const profiles = this.list();
    if (id === undefined) {
      const created: Profile = { id: randomUUID(), createdAt: ts, updatedAt: ts, ...parsed.data };
      await this.commit([...profiles, created]);
      return { ...created };
    }
    const idx = profiles.findIndex((p) => p.id === id);
    const existing = profiles[idx];
    if (!existing) throw new ProfileNotFoundError();
    const updated: Profile = {
      ...existing,
      ...parsed.data,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: ts,
    };
    profiles[idx] = updated;
    await this.commit(profiles);
    return { ...updated };
  }

  async duplicate(id: string): Promise<Profile> {
    const src = this.get(id);
    if (!src) throw new ProfileNotFoundError();
    const ts = this.now().toISOString();
    const copy: Profile = {
      ...src,
      id: randomUUID(),
      name: `${src.name} (copy)`.slice(0, 100),
      createdAt: ts,
      updatedAt: ts,
    };
    const profiles = this.list();
    profiles.splice(profiles.findIndex((p) => p.id === id) + 1, 0, copy);
    await this.commit(profiles);
    return { ...copy };
  }

  /** Removes the profile only: never credential files, downloads or trust. */
  async delete(id: string): Promise<void> {
    const profiles = this.list();
    if (!profiles.some((p) => p.id === id)) throw new ProfileNotFoundError();
    await this.commit(profiles.filter((p) => p.id !== id));
  }
}
