import { app, BrowserWindow, nativeImage, screen, session } from 'electron';
import path from 'node:path';
import type { WindowState } from '../../shared/settings';

const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // blob: for the in-memory full preview and grid thumbnails (version 2); nothing remote.
  "img-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const RENDERER_INDEX = (): string =>
  path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);

/** PNG window icon. Packaged builds copy it next to the app; dev uses the repo file. */
export function appIconFile(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'icon.png');
  return path.join(app.getAppPath(), 'resources', 'icons', 'icon.png');
}

/** macOS dock icon in dev (packaged builds use the .icns in the bundle). */
export function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const icon = nativeImage.createFromPath(appIconFile());
  if (!icon.isEmpty()) app.dock.setIcon(icon);
}

function visible(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) return false;
  const { x, y, width } = state;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    // Title bar area must be on some display.
    return (
      x + width > a.x + 40 && x < a.x + a.width - 40 && y >= a.y - 10 && y < a.y + a.height - 40
    );
  });
}

export function createMainWindow(opts: {
  show: boolean;
  state: WindowState | null;
}): BrowserWindow {
  const s = opts.state;
  const win = new BrowserWindow({
    width: s?.width ?? 1100,
    height: s?.height ?? 720,
    ...(s && visible(s) && s.x !== undefined && s.y !== undefined ? { x: s.x, y: s.y } : {}),
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'SimpleSFTP',
    icon: appIconFile(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      // No developer tools in release builds.
      devTools: !app.isPackaged,
    },
  });
  if (opts.show) {
    win.once('ready-to-show', () => {
      if (s?.maximized) win.maximize();
      win.show();
    });
  }
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(RENDERER_INDEX());
  }
  return win;
}

export function captureWindowState(win: BrowserWindow): WindowState {
  const b = win.getNormalBounds();
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(400, Math.round(b.width)),
    height: Math.max(300, Math.round(b.height)),
    maximized: win.isMaximized(),
  };
}

/** Spec 9.2: production CSP, no unexpected navigation or new windows. */
export function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) return; // Vite dev server needs inline scripts/HMR.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [PROD_CSP] },
      });
    });
  });
}
