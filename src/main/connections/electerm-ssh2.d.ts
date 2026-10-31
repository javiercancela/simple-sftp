// Minimal typings for the subset of @electerm/ssh2 used by the transport
// adapter. The package ships no TypeScript declarations.
declare module '@electerm/ssh2' {
  import type { EventEmitter } from 'node:events';
  import type { Readable } from 'node:stream';

  export interface ParsedKey {
    type: string;
    comment: string;
    getPrivatePEM(): string | null;
    getPublicSSH(algo?: string): Buffer;
    isPrivateKey(): boolean;
  }

  export interface SftpAttrs {
    mode?: number;
    uid?: number;
    gid?: number;
    size?: number;
    atime?: number;
    mtime?: number;
  }

  export interface SftpDirEntry {
    filename: string;
    longname: string;
    attrs: SftpAttrs;
  }

  export interface SftpReadStreamOptions {
    start?: number;
    end?: number;
    highWaterMark?: number;
  }

  export interface SFTPWrapper extends EventEmitter {
    readdir(
      path: string,
      cb: (err: (Error & { code?: number }) | undefined, list: SftpDirEntry[]) => void,
    ): void;
    stat(
      path: string,
      cb: (err: (Error & { code?: number }) | undefined, attrs: SftpAttrs) => void,
    ): void;
    lstat(
      path: string,
      cb: (err: (Error & { code?: number }) | undefined, attrs: SftpAttrs) => void,
    ): void;
    realpath(
      path: string,
      cb: (err: (Error & { code?: number }) | undefined, abs: string) => void,
    ): void;
    createReadStream(path: string, options?: SftpReadStreamOptions): Readable;
    end(): void;
  }

  export type HostVerifier = (key: Buffer, verify: (valid: boolean) => void) => boolean | undefined;

  export interface ConnectConfig {
    host: string;
    port: number;
    username: string;
    privateKey?: ParsedKey | Buffer | string;
    certificate?: Buffer | string;
    passphrase?: string;
    hostVerifier?: HostVerifier;
    authHandler?: string[];
    readyTimeout?: number;
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    tryKeyboard?: boolean;
    agent?: undefined;
    algorithms?: {
      serverHostKey?: string[];
    };
    debug?: (msg: string) => void;
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): this;
    sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void;
    end(): this;
    destroy(): this;
    setNoDelay(noDelay?: boolean): this;
  }

  export const utils: {
    parseKey(data: Buffer | string, passphrase?: string | Buffer): ParsedKey | ParsedKey[] | Error;
    sftp: { STATUS_CODE: Record<string, number> };
  };
}
