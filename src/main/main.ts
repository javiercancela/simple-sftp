import { app, BrowserWindow, nativeTheme } from 'electron';
import started from 'electron-squirrel-startup';
import { pathToFileURL } from 'node:url';
import type { ConnectionSnapshot } from '../shared/connection';
import { IPC_EVENTS, type StartupNotice } from '../shared/ipc-contract';
import { ConnectionManager } from './connections/connection-manager';
import { TrustStore } from './connections/trust-store';
import { registerIpcHandlers } from './ipc/handlers';
import { BrowseService } from './connections/browse-service';
import { createIpcRouter } from './ipc/router';
import { chooseFile } from './platform/dialogs';
import type { Recovery } from './platform/json-file';
import { SettingsStore } from './platform/settings-store';
import {
  captureWindowState,
  createMainWindow,
  hardenWebContents,
  RENDERER_INDEX,
} from './platform/window';
import { ProfileStore } from './profiles/profile-store';

// Windows Squirrel install/uninstall shortcut handling.
if (started) app.quit();

if (!app.requestSingleInstanceLock()) app.quit();

hardenWebContents();

let mainWindow: BrowserWindow | null = null;

function notice(file: StartupNotice['file'], r: Recovery | null, label: string): StartupNotice[] {
  if (!r) return [];
  return [
    {
      id: `recovered-${file}`,
      kind: 'recovered-config',
      file,
      backupPath: r.backupPath,
      message: `Your ${label} file could not be read, so a clean one was started. The original was kept at ${r.backupPath}.`,
    },
  ];
}

async function startApp(): Promise<void> {
  const dir = app.getPath('userData');
  const profiles = new ProfileStore(dir);
  const settings = new SettingsStore(dir);
  const trust = new TrustStore(dir);
  await Promise.all([profiles.load(), settings.load(), trust.load()]);
  const notices = [
    ...notice('profiles', profiles.recovered, 'saved servers'),
    ...notice('settings', settings.recovered, 'settings'),
    ...notice('trustedHosts', trust.recovered, 'trusted hosts'),
  ];
  nativeTheme.themeSource = settings.get().theme;

  const connections = new ConnectionManager({
    getProfile: (id) => profiles.get(id),
    trust,
    emit: (snap: ConnectionSnapshot) =>
      mainWindow?.webContents.send(IPC_EVENTS.connectionState, snap),
  });

  const browse = new BrowseService({ getSession: (id) => connections.getSession(id) });

  const rendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ?? pathToFileURL(RENDERER_INDEX()).href;
  const router = createIpcRouter({
    profiles,
    settings,
    trust,
    connections,
    browse,
    notices,
    appInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    }),
    chooseFile: (kind) => chooseFile(mainWindow, kind),
    isTrustedSender: (s) =>
      !!mainWindow &&
      s.webContentsId === mainWindow.webContents.id &&
      s.isMainFrame &&
      s.frameUrl.split('#')[0] === rendererUrl,
    onSettingsChanged: (st) => {
      nativeTheme.themeSource = st.theme;
    },
    log: (m) => console.error(m),
  });
  registerIpcHandlers(router);

  // Smoke builds only (compile-time flag); release builds contain no hook.
  if (__SFTP_SMOKE_HOOK__ && process.env.SFTP_CLIENT_TRANSPORT_SMOKE) {
    const { runTransportSmoke } = await import('./smoke/transport-smoke');
    mainWindow = createMainWindow({ show: false, state: null });
    app.exit(await runTransportSmoke(process.env.SFTP_CLIENT_TRANSPORT_SMOKE, mainWindow));
    return;
  }

  mainWindow = createMainWindow({ show: true, state: settings.get().window });
  // Persist geometry before the window goes away (atomic write must finish).
  let geometrySaved = false;
  mainWindow.on('close', (event) => {
    const win = mainWindow;
    if (geometrySaved || !win) return;
    event.preventDefault();
    void settings
      .setWindow(captureWindowState(win))
      .catch(() => undefined)
      .finally(() => {
        geometrySaved = true;
        win.close();
      });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  app.on('before-quit', () => {
    void connections.shutdown();
  });
}

app.whenReady().then(startApp, (err: unknown) => {
  console.error(err);
  app.exit(1);
});

// Spec 7.3: closing the only window exits on all platforms (no background mode).
app.on('window-all-closed', () => {
  app.quit();
});
