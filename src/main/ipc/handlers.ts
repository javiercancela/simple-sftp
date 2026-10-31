import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { InvokeChannel } from '../../shared/ipc-contract';
import type { createIpcRouter, SenderInfo } from './router';

function senderInfo(event: IpcMainInvokeEvent): SenderInfo {
  const frame = event.senderFrame;
  return {
    frameUrl: frame?.url ?? '',
    isMainFrame: !!frame && frame.parent === null,
    webContentsId: event.sender.id,
  };
}

/** Register exactly the allowlisted channels; nothing generic is exposed. */
export function registerIpcHandlers(router: ReturnType<typeof createIpcRouter>): void {
  for (const channel of router.channels) {
    ipcMain.handle(channel, (event, payload: unknown) =>
      router.invoke(channel satisfies InvokeChannel, senderInfo(event), payload),
    );
  }
}
