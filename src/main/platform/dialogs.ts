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

/** Native Save dialog for a single download (spec 7.1). */
export async function chooseSavePath(
  parent: BrowserWindow | null,
  defaultPath: string,
): Promise<string | null> {
  const opts: Electron.SaveDialogOptions = {
    title: 'Save download',
    defaultPath,
    buttonLabel: 'Save',
    // Collisions are handled by the app's Replace / Keep both / Skip choice.
    properties: ['createDirectory', 'showHiddenFiles'],
  };
  const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
  return r.canceled || !r.filePath ? null : r.filePath;
}

/** Native folder picker for a multi-file download (spec 7.1). */
export async function chooseDownloadFolder(
  parent: BrowserWindow | null,
  defaultPath: string,
): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = {
    title: 'Choose a folder for the downloads',
    defaultPath,
    buttonLabel: 'Download here',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  const p = r.filePaths[0];
  return r.canceled || !p ? null : p;
}
