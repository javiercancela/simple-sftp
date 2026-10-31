import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeJsonAtomic } from '../../src/main/platform/json-file';
import { SettingsStore } from '../../src/main/platform/settings-store';
import { useTempDir } from './helpers';

describe('settings and atomic JSON', () => {
  const tmp = useTempDir();

  it('defaults when missing; patches persist; window state round-trips', async () => {
    const dir = await tmp();
    const s = new SettingsStore(dir);
    await s.load();
    expect(s.get()).toMatchObject({
      theme: 'system',
      sidebarWidth: 260,
      lastSelectedProfileId: null,
      window: null,
    });
    await s.update({ theme: 'light', sidebarWidth: 300 });
    await s.setWindow({ x: 10, y: 20, width: 1000, height: 700, maximized: false });
    const again = new SettingsStore(dir);
    await again.load();
    expect(again.get()).toMatchObject({
      theme: 'light',
      sidebarWidth: 300,
      window: { width: 1000, height: 700 },
    });
  });

  it('rejects out-of-range or unknown patches without writing', async () => {
    const dir = await tmp();
    const s = new SettingsStore(dir);
    await s.load();
    await expect(s.update({ sidebarWidth: 10 })).rejects.toThrow();
    await expect(s.update({ theme: 'blue' })).rejects.toThrow();
    await expect(s.update({ password: 'x' })).rejects.toThrow();
    await expect(readFile(join(dir, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a corrupt settings file is preserved and defaults are used', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'settings.json'), '\u0000\u0001garbage');
    const s = new SettingsStore(dir);
    await s.load();
    expect(s.get().theme).toBe('system');
    expect(s.recovered?.reason).toMatch(/not valid JSON/);
  });

  it('concurrent atomic writes never leave a partial file', async () => {
    const dir = await tmp();
    const file = join(dir, 'x.json');
    const big = (n: number) => ({ n, pad: 'y'.repeat(200_000) });
    await Promise.all(Array.from({ length: 10 }, (_, i) => writeJsonAtomic(file, big(i))));
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed.pad).toHaveLength(200_000);
  });
});
