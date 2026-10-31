import { app, dialog, type BrowserWindow } from 'electron';
import type { ChooseFileResult } from '../../shared/ipc-contract';

/** Native pickers owned by main (spec 3.1). Only absolute paths come back. */
export async function chooseFile(
  parent: BrowserWindow | null,
  kind: 'privateKey' | 'certificate' | 'downloadDirectory',
): Promise<ChooseFileResult> {
  const sshDir = `${app.getPath('home')}/.ssh`;
  const opts: Electron.OpenDialogOptions =
    kind === 'downloadDirectory'
      ? {
          title: 'Choose download folder',
          defaultPath: app.getPath('downloads'),
          properties: ['openDirectory', 'createDirectory'],
        }
      : {
          title:
            kind === 'privateKey' ? 'Choose SSH private key' : 'Choose OpenSSH user certificate',
          defaultPath: sshDir,
          // File type is detected from content, never from the extension.
          properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'],
        };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  const p = r.filePaths[0];
  if (r.canceled || !p) return { canceled: true };
  return { canceled: false, path: p };
}
