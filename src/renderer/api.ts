import type { SftpClientBridge } from '../shared/ipc-contract';

declare global {
  interface Window {
    sftpClient: SftpClientBridge;
  }
}

export const api = (): SftpClientBridge => window.sftpClient;
