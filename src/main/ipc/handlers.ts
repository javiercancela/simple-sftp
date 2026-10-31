import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC, type AppInfo, type IpcResult } from '../../shared/ipc-contract';

/** Only accept calls from our own top-level renderer frame. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) return url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  return url.startsWith('file://') && event.senderFrame?.parent === null;
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.appGetInfo, (event): IpcResult<AppInfo> => {
    if (!isTrustedSender(event))
      return { ok: false, error: { code: 'FORBIDDEN', message: 'Untrusted sender.' } };
    return {
      ok: true,
      value: {
        name: app.getName(),
        version: app.getVersion(),
        electron: process.versions.electron,
        platform: process.platform,
        arch: process.arch,
      },
    };
  });
}
