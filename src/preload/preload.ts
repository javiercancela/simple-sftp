import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ConnectionSnapshot } from '../shared/connection';
import { IPC, IPC_EVENTS, type SftpClientBridge } from '../shared/ipc-contract';

// One explicit operation per channel; no generic invoke/send is exposed and
// Electron event objects never reach the renderer.
const inv = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);

const bridge: SftpClientBridge = {
  app: {
    getInfo: () => inv(IPC.appGetInfo),
    getNotices: () => inv(IPC.appGetNotices),
    dismissNotice: (noticeId) => inv(IPC.appDismissNotice, { noticeId }),
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
    connect: (profileId) => inv(IPC.connectionsConnect, { profileId }),
    cancel: (sessionId) => inv(IPC.connectionsCancel, { sessionId }),
    disconnect: (sessionId) => inv(IPC.connectionsDisconnect, { sessionId }),
    onState: (listener) => {
      const wrapped = (_e: IpcRendererEvent, snap: ConnectionSnapshot): void => listener(snap);
      ipcRenderer.on(IPC_EVENTS.connectionState, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.connectionState, wrapped);
      };
    },
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
  },
};

contextBridge.exposeInMainWorld('sftpClient', bridge);
