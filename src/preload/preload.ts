import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type SftpClientBridge } from '../shared/ipc-contract';

// One explicit operation per channel; no generic invoke is exposed.
const bridge: SftpClientBridge = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.appGetInfo),
  },
};

contextBridge.exposeInMainWorld('sftpClient', bridge);
