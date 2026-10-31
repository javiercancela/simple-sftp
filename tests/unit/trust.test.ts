import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrustStore } from '../../src/main/connections/trust-store';
import { trustKeyFor } from '../../src/shared/trust';
import { useTempDir } from './helpers';

const FP_A = `SHA256:${'A'.repeat(43)}`;
const FP_B = `SHA256:${'B'.repeat(43)}`;
const key = (
  over: Partial<{ host: string; port: number; algorithm: string; fingerprintSha256: string }> = {},
) => ({
  host: 'files.example.com',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprintSha256: FP_A,
  ...over,
});

describe('trust keys', () => {
  it('normalizes host:port, brackets IPv6', () => {
    expect(trustKeyFor('Files.Example.com', 22)).toBe('files.example.com:22');
    expect(trustKeyFor('::1', 2222)).toBe('[::1]:2222');
    expect(trustKeyFor('[::1]', 2222)).toBe('[::1]:2222');
  });
});

describe('TrustStore', () => {
  const tmp = useTempDir();

  it('unknown → trusted after acceptance, persisted across reload', async () => {
    const dir = await tmp();
    const s = new TrustStore(dir);
    await s.load();
    expect(s.evaluate(key()).kind).toBe('unknown');
    await s.trust(key());
    expect(s.evaluate(key()).kind).toBe('trusted');
    const again = new TrustStore(dir);
    await again.load();
    expect(again.evaluate(key({ host: 'FILES.example.com' })).kind).toBe('trusted');
    expect(again.list()).toHaveLength(1);
  });

  it('a different fingerprint or algorithm is a mismatch with the stored key reported', async () => {
    const s = new TrustStore(await tmp());
    await s.load();
    await s.trust(key());
    const changed = s.evaluate(key({ fingerprintSha256: FP_B }));
    expect(changed).toMatchObject({ kind: 'mismatch', expected: { fingerprintSha256: FP_A } });
    expect(s.evaluate(key({ algorithm: 'ecdsa-sha2-nistp256' })).kind).toBe('mismatch');
  });

  it('trust is per host:port', async () => {
    const s = new TrustStore(await tmp());
    await s.load();
    await s.trust(key());
    expect(s.evaluate(key({ port: 2222 })).kind).toBe('unknown');
    expect(s.evaluate(key({ host: 'other.example.com' })).kind).toBe('unknown');
  });

  it('never silently overwrites; replacing requires remove first', async () => {
    const dir = await tmp();
    const s = new TrustStore(dir);
    await s.load();
    await s.trust(key());
    await expect(s.trust(key({ fingerprintSha256: FP_B }))).rejects.toThrow(/remove it first/);
    expect(await s.remove('files.example.com:22')).toBe(true);
    expect(await s.remove('files.example.com:22')).toBe(false);
    await s.trust(key({ fingerprintSha256: FP_B }));
    const file = JSON.parse(await readFile(join(dir, 'trusted-hosts.json'), 'utf8'));
    expect(file.hosts['files.example.com:22'].fingerprintSha256).toBe(FP_B);
  });

  it('a corrupt trust file is set aside; nothing is trusted', async () => {
    const dir = await tmp();
    await writeFile(
      join(dir, 'trusted-hosts.json'),
      JSON.stringify({ version: 1, hosts: { x: { bogus: 1 } } }),
    );
    const s = new TrustStore(dir);
    await s.load();
    expect(s.recovered).not.toBeNull();
    expect(s.list()).toEqual([]);
  });
});
