import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProfileNotFoundError,
  ProfileStore,
  ProfileValidationError,
} from '../../src/main/profiles/profile-store';
import {
  ProfileInputSchema,
  isValidHost,
  normalizeHostInput,
  profileFieldErrors,
} from '../../src/shared/profiles';
import { useTempDir } from './helpers';

const valid = {
  name: 'Production',
  host: 'files.example.com',
  port: 22,
  username: 'deploy',
  authMode: 'privateKeyAndCertificate' as const,
  privateKeyPath: '/home/me/.ssh/id_ed25519',
  certificatePath: '/home/me/.ssh/id_ed25519-cert.pub',
  initialRemoteDirectory: null,
  downloadDirectory: null,
};

describe('profile validation', () => {
  it('accepts a complete certificate profile', () => {
    expect(profileFieldErrors(valid)).toEqual({});
  });

  it.each([
    ['files.example.com', true],
    ['localhost', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['fe80::1', true],
    ['2001:db8::8a2e:370:7334', true],
    ['sftp://host', false],
    ['user@host', false],
    ['host:22', false],
    ['bad host', false],
    ['999.1.1.1', false],
    ['-leading.example', false],
    ['', false],
  ])('host %j valid=%s', (host, ok) => {
    expect(isValidHost(normalizeHostInput(host))).toBe(ok);
  });

  it('normalizes host case, whitespace and IPv6 brackets', () => {
    expect(ProfileInputSchema.parse({ ...valid, host: '  Files.Example.COM ' }).host).toBe(
      'files.example.com',
    );
    expect(ProfileInputSchema.parse({ ...valid, host: '[::1]' }).host).toBe('::1');
  });

  it('reports field errors for bad port, username, paths and remote dir', () => {
    const errs = profileFieldErrors({
      ...valid,
      name: '  ',
      port: 70000,
      username: 'two words',
      privateKeyPath: 'relative/key',
      initialRemoteDirectory: 'srv/files',
    });
    expect(Object.keys(errs).sort()).toEqual([
      'initialRemoteDirectory',
      'name',
      'port',
      'privateKeyPath',
      'username',
    ]);
    expect(profileFieldErrors({ ...valid, port: 22.5 })).toHaveProperty('port');
    expect(profileFieldErrors({ ...valid, port: 0 })).toHaveProperty('port');
  });

  it('requires a certificate in certificate mode and drops it in key mode', () => {
    expect(profileFieldErrors({ ...valid, certificatePath: null })).toHaveProperty(
      'certificatePath',
    );
    const keyOnly = ProfileInputSchema.parse({ ...valid, authMode: 'privateKey' });
    expect(keyOnly.certificatePath).toBeNull();
  });

  it('rejects control characters and unknown keys (no secrets can ride along)', () => {
    expect(profileFieldErrors({ ...valid, name: 'a\u0007b' })).toHaveProperty('name');
    expect(ProfileInputSchema.safeParse({ ...valid, passphrase: 'x' }).success).toBe(false);
    expect(ProfileInputSchema.safeParse({ ...valid, password: 'x' }).success).toBe(false);
  });
});

describe('ProfileStore', () => {
  const tmp = useTempDir();

  it('creates, updates, duplicates and deletes with stable UUIDs, persisted atomically', async () => {
    const dir = await tmp();
    let t = 0;
    const store = new ProfileStore(dir, () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)));
    await store.load();
    const a = await store.save(undefined, valid);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    const updated = await store.save(a.id, { ...valid, name: 'Renamed', port: 2222 });
    expect(updated.id).toBe(a.id);
    expect(updated.createdAt).toBe(a.createdAt);
    expect(updated.updatedAt > a.updatedAt).toBe(true);
    const copy = await store.duplicate(a.id);
    expect(copy.id).not.toBe(a.id);
    expect(copy.name).toBe('Renamed (copy)');
    expect(copy.port).toBe(2222);

    const reloaded = new ProfileStore(dir);
    await reloaded.load();
    expect(reloaded.list().map((p) => p.id)).toEqual([a.id, copy.id]);
    expect(reloaded.get(a.id)?.name).toBe('Renamed');

    await reloaded.delete(copy.id);
    const file = JSON.parse(await readFile(join(dir, 'profiles.json'), 'utf8'));
    expect(file.version).toBe(1);
    expect(file.profiles).toHaveLength(1);
    // No temp files left behind by the atomic writer.
    expect(await readdir(dir)).toEqual(['profiles.json']);
  });

  it('rejects invalid input with field errors and unknown ids with NOT_FOUND', async () => {
    const store = new ProfileStore(await tmp());
    await store.load();
    await expect(store.save(undefined, { ...valid, port: -1 })).rejects.toBeInstanceOf(
      ProfileValidationError,
    );
    await expect(store.save('00000000-0000-4000-8000-000000000000', valid)).rejects.toBeInstanceOf(
      ProfileNotFoundError,
    );
    await expect(store.delete('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      ProfileNotFoundError,
    );
    expect(store.list()).toEqual([]);
  });

  it('preserves a corrupt profiles file and starts clean', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'profiles.json'), '{ not json');
    const store = new ProfileStore(dir);
    await store.load();
    expect(store.list()).toEqual([]);
    expect(store.recovered?.backupPath).toMatch(/profiles\.json\.corrupt-/);
    expect(await readFile(store.recovered!.backupPath, 'utf8')).toBe('{ not json');
  });

  it('treats a future file version as unreadable rather than guessing', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'profiles.json'), JSON.stringify({ version: 2, profiles: [] }));
    const store = new ProfileStore(dir);
    await store.load();
    expect(store.recovered?.reason).toMatch(/version/);
  });
});
