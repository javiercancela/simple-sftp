// Build the production bundle, then run the Electron E2E tests.
// Linux without a display: wraps vitest in xvfb-run.
import { spawnSync } from 'node:child_process';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('npx', ['electron-forge', 'package']);
const vitest = ['vitest', 'run', 'tests/e2e'];
if (process.platform === 'linux' && !process.env.DISPLAY) {
  run('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', 'npx', ...vitest]);
} else {
  run('npx', vitest);
}
