import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';

const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function createMainWindow(opts: { show: boolean }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: opts.show,
    title: 'SimpleSFTP',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  return win;
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
    if (!app.isPackaged) return; // Vite dev server needs inline scripts/HMR.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [PROD_CSP] },
      });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  });
}
