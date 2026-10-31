/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

/** Compile-time flag: true only in smoke-test builds (SFTP_CLIENT_SMOKE_BUILD=1). */
// oxlint-disable-next-line no-underscore-dangle
declare const __SFTP_SMOKE_HOOK__: boolean;
