// IPC channel names and payload schemas. Pure: no Electron/Node imports.
import { z } from 'zod';

export const IPC = {
  appGetInfo: 'app.getInfo',
} as const;

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  platform: z.string(),
  arch: z.string(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/** Consistent result envelope for every IPC call (spec 9.4). */
export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

/** Shape exposed on window.sftpClient by the preload bridge. */
export interface SftpClientBridge {
  app: { getInfo(): Promise<IpcResult<AppInfo>> };
}
