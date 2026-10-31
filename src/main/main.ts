import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ConnectionSnapshot } from '../shared/connection';
import type { DownloadsSnapshot } from '../shared/downloads';
import {
  IPC_EVENTS,
  type QuitChoice,
  type QuitRequest,
  type StartupNotice,
} from '../shared/ipc-contract';
import { BrowseService } from './connections/browse-service';
import { ConnectionManager, StaleRequestError } from './connections/connection-manager';
import { TrustStore } from './connections/trust-store';
import { DownloadService } from './downloads/download-service';
import { TransferJournal } from './downloads/journal';
import { registerIpcHandlers } from './ipc/handlers';
import { createIpcRouter } from './ipc/router';
import { chooseDownloadFolder, chooseFile, chooseSavePath } from './platform/dialogs';
import type { Recovery } from './platform/json-file';
import { installAppMenu } from './platform/menu';
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

function notice(
  file: 'profiles' | 'settings' | 'trustedHosts' | 'transferJournal',
  r: Recovery | null,
  label: string,
): StartupNotice[] {
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

const send = (channel: string, value: unknown): void => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
};

async function startApp(): Promise<void> {
  installAppMenu(process.platform);
  const dir = app.getPath('userData');
  const profiles = new ProfileStore(dir);
  const settings = new SettingsStore(dir);
  const trust = new TrustStore(dir);
  const journal = new TransferJournal(dir);
  await Promise.all([profiles.load(), settings.load(), trust.load(), journal.load()]);
  const notices = [
    ...notice('profiles', profiles.recovered, 'saved servers'),
    ...notice('settings', settings.recovered, 'settings'),
    ...notice('trustedHosts', trust.recovered, 'trusted hosts'),
    ...notice('transferJournal', journal.recovered, 'download records'),
  ];
  nativeTheme.themeSource = settings.get().theme;

  let downloads: DownloadService | null = null;
  const connections = new ConnectionManager({
    getProfile: (id) => profiles.get(id),
    trust,
    emit: (snap: ConnectionSnapshot) => {
      send(IPC_EVENTS.connectionState, snap);
      downloads?.connectionChanged();
    },
  });

  const browse = new BrowseService({ getSession: (id) => connections.getSession(id) });

  downloads = new DownloadService({
    connection: () => {
      const s = connections.getSnapshot();
      return {
        sessionId: s.sessionId,
        profileId: s.profileId,
        profileName: s.profileName,
        connected: s.state === 'connected',
      };
    },
    getSession: (id) => connections.getSession(id),
    getProfile: (id) => profiles.get(id),
    saveDialog: (p) => chooseSavePath(mainWindow, p),
    chooseDirectory: (p) => chooseDownloadFolder(mainWindow, p),
    defaultDownloadDir: () => app.getPath('downloads'),
    journal,
    platform: process.platform,
    emit: (s: DownloadsSnapshot) => send(IPC_EVENTS.downloads, s),
    reveal: (p) => shell.showItemInFolder(p),
    log: (m) => console.error(m),
  });
  const dl = downloads;

  // Partial files from an earlier run (app-owned, journaled only): offer cleanup.
  const orphans = await dl.findStartupOrphans().catch(() => []);
  if (orphans.length > 0) {
    notices.push({
      id: 'orphan-partials',
      kind: 'orphan-partials',
      message: `${orphans.length} unfinished download${orphans.length === 1 ? '' : 's'} from an earlier session left partial files. Downloads never resume after a restart.`,
      paths: orphans.map((o) => o.partPath),
    });
  }

  // Quit/close with pending downloads (spec 7.3): the renderer asks the user.
  let quitConfirmed = false;
  let quitRequest: QuitRequest | null = null;
  const askQuit = (): void => {
    quitRequest ??= {
      requestId: randomUUID(),
      pendingCount: dl
        .getSnapshot()
        .jobs.filter((j) => j.state === 'queued' || j.state === 'downloading').length,
    };
    if (!mainWindow || mainWindow.isDestroyed()) {
      // No window to ask in: never leave a hidden background transfer.
      quitConfirmed = true;
      void dl.cancelAll().finally(() => app.quit());
      return;
    }
    mainWindow.show();
    mainWindow.focus();
    send(IPC_EVENTS.quitRequest, quitRequest);
  };
  const mustAsk = (): boolean => !quitConfirmed && dl.hasPending();

  const resolveQuit = async (requestId: string, choice: QuitChoice): Promise<void> => {
    if (!quitRequest || quitRequest.requestId !== requestId)
      throw new StaleRequestError('Quit request');
    quitRequest = null;
    if (choice === 'keepDownloading') return;
    await dl.cancelAll();
    quitConfirmed = true;
    app.quit();
  };

  const rendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ?? pathToFileURL(RENDERER_INDEX()).href;
  const router = createIpcRouter({
    profiles,
    settings,
    trust,
    connections,
    browse,
    downloads: dl,
    resolveQuit,
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
    if (!win) return;
    if (mustAsk()) {
      event.preventDefault();
      askQuit();
      return;
    }
    if (geometrySaved) return;
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
  app.on('before-quit', (event) => {
    if (mustAsk()) {
      event.preventDefault();
      askQuit();
      return;
    }
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
