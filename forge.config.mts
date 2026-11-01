import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { chmod, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Electron's release zip stores world-writable modes (0777/0666) and they are
 * copied into the package, the .deb and the portable zip as-is. An installed
 * executable that any local user can overwrite is a privilege problem, so
 * clear group/other write bits on everything (symlinks are left alone).
 */
async function removeGroupOtherWrite(path: string): Promise<void> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) return;
  if (st.mode & 0o022) await chmod(path, st.mode & 0o7755);
  if (st.isDirectory())
    for (const e of await readdir(path)) await removeGroupOtherWrite(join(path, e));
}

// Smoke builds (scripts/smoke-packaged.mjs) compile in the transport smoke
// hook and go to their own folder so they never mix with release artifacts.
const smokeBuild = process.env.SFTP_CLIENT_SMOKE_BUILD === '1';

const config: ForgeConfig = {
  outDir: smokeBuild ? 'out-smoke' : 'out',
  packagerConfig: {
    asar: true,
    name: 'SimpleSFTP',
    executableName: 'simple-sftp',
    appBundleId: 'dev.javiercancela.simplesftp',
    // resources/icons/icon.{icns,ico,png} — no extension; packager picks the OS file.
    icon: 'resources/icons/icon',
    // Licence notices for bundled dependencies (generated; see scripts/).
    // icon.png is the BrowserWindow / Linux icon (basename lands in Resources).
    extraResource: ['THIRD_PARTY_NOTICES.md', 'resources/icons/icon.png'],
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_config, { outputPaths, platform }) => {
      if (platform === 'win32') return;
      for (const p of outputPaths) await removeGroupOtherWrite(p);
    },
  },
  makers: [
    // Windows x64 installer (unsigned dev build).
    new MakerSquirrel({ name: 'SimpleSFTP' }),
    // macOS .dmg (arm64 / x64, built on matching macOS runners).
    new MakerDMG({}, ['darwin']),
    // Portable archives: macOS and Linux.
    new MakerZIP({}, ['darwin', 'linux']),
    // Linux .deb (Ubuntu 24.04+ baseline).
    new MakerDeb({
      options: {
        name: 'simple-sftp',
        productName: 'SimpleSFTP',
        bin: 'simple-sftp',
        categories: ['Network', 'Utility'],
        icon: 'resources/icons/icon.png',
      },
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.mts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.mts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
