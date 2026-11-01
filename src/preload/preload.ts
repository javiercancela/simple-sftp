import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ConnectionSnapshot } from '../shared/connection';
import type { DownloadsSnapshot } from '../shared/downloads';
import { IPC, IPC_EVENTS, type QuitRequest, type SftpClientBridge } from '../shared/ipc-contract';

// One explicit operation per channel; no generic invoke/send is exposed and
// Electron event objects never reach the renderer.
const inv = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);

/** Subscribe to one event channel; the Electron event object is dropped. */
function on<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_e: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const bridge: SftpClientBridge = {
  app: {
    getInfo: () => inv(IPC.appGetInfo),
    getNotices: () => inv(IPC.appGetNotices),
    dismissNotice: (noticeId) => inv(IPC.appDismissNotice, { noticeId }),
    resolveQuit: (requestId, choice) => inv(IPC.appResolveQuit, { requestId, choice }),
    onQuitRequest: (listener) => on<QuitRequest>(IPC_EVENTS.quitRequest, listener),
  },
  profiles: {
    list: () => inv(IPC.profilesList),
    save: (id, input) => inv(IPC.profilesSave, id === undefined ? { input } : { id, input }),
    duplicate: (id) => inv(IPC.profilesDuplicate, { id }),
    delete: (id) => inv(IPC.profilesDelete, { id }),
  },
  credentials: {
    chooseFile: (kind) => inv(IPC.credentialsChooseFile, { kind }),
  },
  settings: {
    get: () => inv(IPC.settingsGet),
    update: (patch) => inv(IPC.settingsUpdate, patch),
  },
  connections: {
    getState: () => inv(IPC.connectionsGetState),
    connect: (profileId, cancelDownloads) =>
      inv(
        IPC.connectionsConnect,
        cancelDownloads === undefined ? { profileId } : { profileId, cancelDownloads },
      ),
    cancel: (sessionId) => inv(IPC.connectionsCancel, { sessionId }),
    disconnect: (sessionId, cancelDownloads) =>
      inv(
        IPC.connectionsDisconnect,
        cancelDownloads === undefined ? { sessionId } : { sessionId, cancelDownloads },
      ),
    onState: (listener) => on<ConnectionSnapshot>(IPC_EVENTS.connectionState, listener),
  },
  trust: {
    accept: (challengeId) => inv(IPC.trustAccept, { challengeId }),
    reject: (challengeId) => inv(IPC.trustReject, { challengeId }),
  },
  passphrase: {
    submit: (challengeId, passphrase) => inv(IPC.passphraseSubmit, { challengeId, passphrase }),
    cancel: (challengeId) => inv(IPC.passphraseCancel, { challengeId }),
  },
  trustedHosts: {
    list: () => inv(IPC.trustedHostsList),
    remove: (key) => inv(IPC.trustedHostsRemove, { key }),
  },
  remote: {
    list: (sessionId, requestId, path) => inv(IPC.remoteList, { sessionId, requestId, path }),
    cancel: (sessionId, requestId) => inv(IPC.remoteCancel, { sessionId, requestId }),
    previewImage: (sessionId, requestId, path) =>
      inv(IPC.remotePreviewImage, { sessionId, requestId, path }),
    cancelPreview: (sessionId, requestId) => inv(IPC.remoteCancelPreview, { sessionId, requestId }),
    thumbnail: (sessionId, requestId, path, size) =>
      inv(IPC.remoteThumbnail, { sessionId, requestId, path, size }),
    cancelThumbnail: (sessionId, requestId) =>
      inv(IPC.remoteCancelThumbnail, { sessionId, requestId }),
  },
  previews: {
    clearCache: () => inv(IPC.previewsClearCache),
  },
  downloads: {
    list: () => inv(IPC.downloadsList),
    chooseDestinationAndEnqueue: (sessionId, paths) =>
      inv(IPC.downloadsEnqueue, { sessionId, paths }),
    resolvePlan: (planId, decisions) => inv(IPC.downloadsResolvePlan, { planId, decisions }),
    cancelPlan: (planId) => inv(IPC.downloadsCancelPlan, { planId }),
    resolveConflict: (jobId, promptId, choice) =>
      inv(IPC.downloadsResolveConflict, { jobId, promptId, choice }),
    cancel: (jobId) => inv(IPC.downloadsCancel, { jobId }),
    retry: (jobId) => inv(IPC.downloadsRetry, { jobId }),
    reveal: (jobId) => inv(IPC.downloadsReveal, { jobId }),
    retryCleanup: (jobId) => inv(IPC.downloadsRetryCleanup, { jobId }),
    continue: () => inv(IPC.downloadsContinue),
    cancelAll: () => inv(IPC.downloadsCancelAll),
    clearFinished: () => inv(IPC.downloadsClearFinished),
    resolveOrphans: (action) => inv(IPC.downloadsResolveOrphans, { action }),
    onChange: (listener) => on<DownloadsSnapshot>(IPC_EVENTS.downloads, listener),
  },
};

contextBridge.exposeInMainWorld('sftpClient', bridge);
