import { app, BrowserWindow } from 'electron';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc/handlers';
import { createMainWindow, hardenWebContents } from './platform/window';
import { runTransportSmoke } from './smoke/transport-smoke';

// Windows Squirrel install/uninstall shortcut handling.
if (started) app.quit();

hardenWebContents();

/**
 * Packaged-transport smoke hook (spec 3.2 step 6). Only active when this env
 * var points at a smoke config file; normal launches ignore it.
 */
const smokeConfigPath = process.env.SFTP_CLIENT_TRANSPORT_SMOKE;

app.whenReady().then(async () => {
  registerIpcHandlers();
  const win = createMainWindow({ show: !smokeConfigPath });
  if (smokeConfigPath) {
    const code = await runTransportSmoke(smokeConfigPath, win);
    app.exit(code);
    return;
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ show: true });
  });
});

// Spec 7.3: closing the only window exits on all platforms (no background mode).
app.on('window-all-closed', () => {
  app.quit();
});
