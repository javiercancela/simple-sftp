import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'SimpleSFTP',
    executableName: 'simple-sftp',
    appBundleId: 'dev.javiercancela.simplesftp',
  },
  rebuildConfig: {},
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
