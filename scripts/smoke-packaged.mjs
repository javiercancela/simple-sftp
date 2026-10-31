// Packaged smoke (spec 11):
//  1. builds a separate *smoke-flavored* package into out-smoke/ (the transport
//     smoke hook is compiled in only when SFTP_CLIENT_SMOKE_BUILD=1),
//  2. runs tests/smoke against it (real sshd, certificate login, hashed download)
//     and against the release artifacts in out/make (hook absent, UI starts).
// Prerequisite: `npm run make` for the release artifacts.
import { spawnSync } from 'node:child_process';

const run = (cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('npx', ['electron-forge', 'make'], { ...process.env, SFTP_CLIENT_SMOKE_BUILD: '1' });
// Leave .vite/ holding a release build again so `npm start`/E2E never pick up
// the smoke flavor by accident.
run('npx', ['electron-forge', 'package']);
run('npx', ['vitest', 'run', 'tests/smoke']);
