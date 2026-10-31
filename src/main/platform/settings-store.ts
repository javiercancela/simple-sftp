import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  SettingsSchema,
  type Settings,
  type WindowState,
} from '../../shared/settings';
import { VersionedJsonFile, type Recovery } from './json-file';

export class SettingsStore {
  private readonly file: VersionedJsonFile<typeof SettingsSchema>;
  private data: Settings = { ...DEFAULT_SETTINGS };
  recovered: Recovery | null = null;

  constructor(dir: string) {
    this.file = new VersionedJsonFile(path.join(dir, 'settings.json'), SettingsSchema, () => ({
      ...DEFAULT_SETTINGS,
    }));
  }

  async load(): Promise<void> {
    const r = await this.file.load();
    this.data = r.data;
    this.recovered = r.recovered;
  }

  get(): Settings {
    return structuredClone(this.data);
  }

  /** Validates a renderer-supplied patch (throws ZodError on bad input). */
  async update(patch: unknown): Promise<Settings> {
    const p = SettingsPatchSchema.parse(patch);
    const next: Settings = { ...this.data };
    if (p.theme !== undefined) next.theme = p.theme;
    if (p.sidebarWidth !== undefined) next.sidebarWidth = p.sidebarWidth;
    if (p.lastSelectedProfileId !== undefined) next.lastSelectedProfileId = p.lastSelectedProfileId;
    await this.file.save(next);
    this.data = next;
    return this.get();
  }

  async setWindow(window: WindowState): Promise<void> {
    const next: Settings = { ...this.data, window };
    await this.file.save(next);
    this.data = next;
  }
}
