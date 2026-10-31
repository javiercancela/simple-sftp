import { defineConfig } from 'vite';

// The packaged transport smoke hook is compiled in only for smoke builds
// (scripts/smoke-packaged.mjs). Release builds dead-code-eliminate it.
const smokeBuild = process.env.SFTP_CLIENT_SMOKE_BUILD === '1';

export default defineConfig({
  define: {
    __SFTP_SMOKE_HOOK__: JSON.stringify(smokeBuild),
  },
});
