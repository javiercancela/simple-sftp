import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('THIRD_PARTY_NOTICES.md matches the production dependency tree', () => {
  const r = spawnSync(process.execPath, ['scripts/generate-notices.mjs', '--check'], {
    cwd: resolve(__dirname, '..', '..'),
    encoding: 'utf8',
  });
  expect(r.status, r.stderr + r.stdout).toBe(0);
}, 60_000);
