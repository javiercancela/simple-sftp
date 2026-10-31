// IPC channel names, payload schemas and the typed bridge. Pure.
import { z } from 'zod';
import type { Listing } from './browse';
import { MAX_REMOTE_PATH } from './remote-path';
import type { ConnectionSnapshot } from './connection';
import type { Profile } from './profiles';
import type { Settings, SettingsPatch } from './settings';
import type { TrustedHost } from './trust';

/** Every invoke channel. Anything else is rejected by main. */
export const IPC = {
  appGetInfo: 'app.getInfo',
  appGetNotices: 'app.getNotices',
  appDismissNotice: 'app.dismissNotice',
  profilesList: 'profiles.list',
  profilesSave: 'profiles.save',
  profilesDuplicate: 'profiles.duplicate',
  profilesDelete: 'profiles.delete',
  credentialsChooseFile: 'credentials.chooseFile',
  settingsGet: 'settings.get',
  settingsUpdate: 'settings.update',
  connectionsGetState: 'connections.getState',
  connectionsConnect: 'connections.connect',
  connectionsCancel: 'connections.cancel',
  connectionsDisconnect: 'connections.disconnect',
  trustAccept: 'trust.accept',
  trustReject: 'trust.reject',
  passphraseSubmit: 'passphrase.submit',
  passphraseCancel: 'passphrase.cancel',
  trustedHostsList: 'trustedHosts.list',
  trustedHostsRemove: 'trustedHosts.remove',
  remoteList: 'remote.list',
  remoteCancel: 'remote.cancel',
} as const;
export type InvokeChannel = (typeof IPC)[keyof typeof IPC];

/** Main → renderer event channels. */
export const IPC_EVENTS = {
  connectionState: 'event.connectionState',
} as const;

const Uuid = z.uuid();
/** Absolute POSIX remote path; normalized again in main. */
const RemotePath = z
  .string()
  .min(1)
  .max(MAX_REMOTE_PATH)
  .refine((p) => p.startsWith('/') && !p.includes('\0'), 'Must be an absolute remote path');
const Empty = z.undefined();

/** Payload schema per channel (strict: unknown keys are rejected). */
export const PayloadSchemas = {
  [IPC.appGetInfo]: Empty,
  [IPC.appGetNotices]: Empty,
  [IPC.appDismissNotice]: z.object({ noticeId: z.string().min(1).max(100) }).strict(),
  [IPC.profilesList]: Empty,
  // `input` is validated by ProfileInputSchema in main.
  [IPC.profilesSave]: z.object({ id: Uuid.optional(), input: z.unknown() }).strict(),
  [IPC.profilesDuplicate]: z.object({ id: Uuid }).strict(),
  [IPC.profilesDelete]: z.object({ id: Uuid }).strict(),
  [IPC.credentialsChooseFile]: z
    .object({ kind: z.enum(['privateKey', 'certificate', 'downloadDirectory']) })
    .strict(),
  [IPC.settingsGet]: Empty,
  [IPC.settingsUpdate]: z.unknown(), // SettingsPatchSchema in main
  [IPC.connectionsGetState]: Empty,
  [IPC.connectionsConnect]: z.object({ profileId: Uuid }).strict(),
  [IPC.connectionsCancel]: z.object({ sessionId: Uuid }).strict(),
  [IPC.connectionsDisconnect]: z.object({ sessionId: Uuid }).strict(),
  [IPC.trustAccept]: z.object({ challengeId: Uuid }).strict(),
  [IPC.trustReject]: z.object({ challengeId: Uuid }).strict(),
  [IPC.passphraseSubmit]: z
    .object({ challengeId: Uuid, passphrase: z.string().min(1).max(1024) })
    .strict(),
  [IPC.passphraseCancel]: z.object({ challengeId: Uuid }).strict(),
  [IPC.trustedHostsList]: Empty,
  [IPC.trustedHostsRemove]: z.object({ key: z.string().min(3).max(300) }).strict(),
  [IPC.remoteList]: z.object({ sessionId: Uuid, requestId: Uuid, path: RemotePath }).strict(),
  [IPC.remoteCancel]: z.object({ sessionId: Uuid, requestId: Uuid }).strict(),
} satisfies Record<InvokeChannel, z.ZodType>;

export const IPC_ERROR_CODES = [
  'INVALID_PAYLOAD',
  'FORBIDDEN',
  'UNKNOWN_CHANNEL',
  'NOT_FOUND',
  'STALE',
  'VALIDATION',
  'STORAGE',
  'INTERNAL',
] as const;
export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export interface IpcError {
  code: IpcErrorCode | string;
  message: string;
  fields?: Record<string, string>;
}

/** Consistent result envelope for every IPC call (spec 9.4). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  platform: string;
  arch: string;
}

export interface StartupNotice {
  id: string;
  kind: 'recovered-config';
  file: 'profiles' | 'settings' | 'trustedHosts';
  backupPath: string;
  message: string;
}

export interface TrustedHostEntry extends TrustedHost {
  key: string;
}

export type ChooseFileResult = { canceled: true } | { canceled: false; path: string };

/** Shape exposed on window.sftpClient by the preload bridge. */
export interface SftpClientBridge {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>;
    getNotices(): Promise<IpcResult<StartupNotice[]>>;
    dismissNotice(noticeId: string): Promise<IpcResult<null>>;
  };
  profiles: {
    list(): Promise<IpcResult<Profile[]>>;
    save(id: string | undefined, input: unknown): Promise<IpcResult<Profile>>;
    duplicate(id: string): Promise<IpcResult<Profile>>;
    delete(id: string): Promise<IpcResult<null>>;
  };
  credentials: {
    chooseFile(
      kind: 'privateKey' | 'certificate' | 'downloadDirectory',
    ): Promise<IpcResult<ChooseFileResult>>;
  };
  settings: {
    get(): Promise<IpcResult<Settings>>;
    update(patch: SettingsPatch): Promise<IpcResult<Settings>>;
  };
  connections: {
    getState(): Promise<IpcResult<ConnectionSnapshot>>;
    connect(profileId: string): Promise<IpcResult<{ sessionId: string }>>;
    cancel(sessionId: string): Promise<IpcResult<null>>;
    disconnect(sessionId: string): Promise<IpcResult<null>>;
    onState(listener: (snapshot: ConnectionSnapshot) => void): () => void;
  };
  trust: {
    accept(challengeId: string): Promise<IpcResult<null>>;
    reject(challengeId: string): Promise<IpcResult<null>>;
  };
  passphrase: {
    submit(challengeId: string, passphrase: string): Promise<IpcResult<null>>;
    cancel(challengeId: string): Promise<IpcResult<null>>;
  };
  trustedHosts: {
    list(): Promise<IpcResult<TrustedHostEntry[]>>;
    remove(key: string): Promise<IpcResult<null>>;
  };
  remote: {
    list(sessionId: string, requestId: string, path: string): Promise<IpcResult<Listing>>;
    cancel(sessionId: string, requestId: string): Promise<IpcResult<null>>;
  };
}
