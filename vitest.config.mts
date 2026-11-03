import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // The 4 GiB download and the localhost timing guards share a disk. On a
    // small CI runner, running those files together blew the 10s listing
    // budget and the 8 MiB/s floor (macos-15-intel, actions run 41236013385).
    fileParallelism: false,
  },
});
