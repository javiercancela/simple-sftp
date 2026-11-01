// IPC channel names, payload schemas and the typed bridge. Pure.
import { z } from 'zod';
import type { Listing } from './browse';
import type { ImagePreview, Thumbnail } from './preview';
import type { CollisionChoice, DownloadsSnapshot, EnqueueResult, PlanDecision } from './downloads';
import { MAX_REMOTE_PATH } from './remote-path';
import type { ConnectionSnapshot } from './connection';
import type { Profile } from './profiles';
import { PreviewSizeSchema, type Settings, type SettingsPatch } from './settings';
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
  remotePreviewImage: 'remote.previewImage',
  remoteCancelPreview: 'remote.cancelPreview',
  remoteThumbnail: 'remote.thumbnail',
  remoteCancelThumbnail: 'remote.cancelThumbnail',
  previewsClearCache: 'previews.clearCache',
  downloadsList: 'downloads.list',
  downloadsEnqueue: 'downloads.chooseDestinationAndEnqueue',
  downloadsResolvePlan: 'downloads.resolvePlan',
  downloadsCancelPlan: 'downloads.cancelPlan',
  downloadsResolveConflict: 'downloads.resolveConflict',
  downloadsCancel: 'downloads.cancel',
  downloadsRetry: 'downloads.retry',
  downloadsReveal: 'downloads.reveal',
  downloadsRetryCleanup: 'downloads.retryCleanup',
  downloadsContinue: 'downloads.continue',
  downloadsCancelAll: 'downloads.cancelAll',
  downloadsClearFinished: 'downloads.clearFinished',
  downloadsResolveOrphans: 'downloads.resolveOrphans',
  appResolveQuit: 'app.resolveQuit',
} as const;
export type InvokeChannel = (typeof IPC)[keyof typeof IPC];

/** Main → renderer event channels. */
export const IPC_EVENTS = {
  connectionState: 'event.connectionState',
  downloads: 'event.downloads',
  quitRequest: 'event.quitRequest',
} as const;

/** Main asks the renderer how to handle quitting with pending downloads. */
export interface QuitRequest {
  requestId: string;
  pendingCount: number;
}
export type QuitChoice = 'keepDownloading' | 'cancelAndQuit';

const Uuid = z.uuid();
/** Absolute POSIX remote path; normalized again in main. */
const RemotePath = z
  .string()
  .min(1)
  .max(MAX_REMOTE_PATH)
  .refine((p) => p.startsWith('/') && !p.includes('\0'), 'Must be an absolute remote path');
const Empty = z.undefined();
const Collision = z.enum(['replace', 'keepBoth', 'skip']);

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
  [IPC.connectionsConnect]: z
    .object({ profileId: Uuid, cancelDownloads: z.boolean().optional() })
    .strict(),
  [IPC.connectionsCancel]: z.object({ sessionId: Uuid }).strict(),
  [IPC.connectionsDisconnect]: z
    .object({ sessionId: Uuid, cancelDownloads: z.boolean().optional() })
    .strict(),
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
  [IPC.remotePreviewImage]: z
    .object({ sessionId: Uuid, requestId: Uuid, path: RemotePath })
    .strict(),
  [IPC.remoteCancelPreview]: z.object({ sessionId: Uuid, requestId: Uuid }).strict(),
  [IPC.remoteThumbnail]: z
    .object({
      sessionId: Uuid,
      requestId: Uuid,
      path: RemotePath,
      size: PreviewSizeSchema,
    })
    .strict(),
  [IPC.remoteCancelThumbnail]: z.object({ sessionId: Uuid, requestId: Uuid }).strict(),
  [IPC.previewsClearCache]: Empty,
  [IPC.downloadsList]: Empty,
  // Remote paths only: the local destination always comes from a native dialog in main.
  [IPC.downloadsEnqueue]: z
    .object({ sessionId: Uuid, paths: z.array(RemotePath).min(1).max(1000) })
    .strict(),
  [IPC.downloadsResolvePlan]: z
    .object({
      planId: Uuid,
      decisions: z
        .array(
          z
            .object({
              itemId: Uuid,
              action: z.enum(['replace', 'keepBoth', 'skip', 'rename']),
              // A plain file name (validated again in main), never a path.
              name: z.string().min(1).max(1024).optional(),
            })
            .strict(),
        )
        .max(1000),
    })
    .strict(),
  [IPC.downloadsCancelPlan]: z.object({ planId: Uuid }).strict(),
  [IPC.downloadsResolveConflict]: z
    .object({ jobId: Uuid, promptId: Uuid, choice: Collision })
    .strict(),
  [IPC.downloadsCancel]: z.object({ jobId: Uuid }).strict(),
  [IPC.downloadsRetry]: z.object({ jobId: Uuid }).strict(),
  [IPC.downloadsReveal]: z.object({ jobId: Uuid }).strict(),
  [IPC.downloadsRetryCleanup]: z.object({ jobId: Uuid }).strict(),
  [IPC.downloadsContinue]: Empty,
  [IPC.downloadsCancelAll]: Empty,
  [IPC.downloadsClearFinished]: Empty,
  [IPC.downloadsResolveOrphans]: z.object({ action: z.enum(['delete', 'keep']) }).strict(),
  [IPC.appResolveQuit]: z
    .object({ requestId: Uuid, choice: z.enum(['keepDownloading', 'cancelAndQuit']) })
    .strict(),
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
  'DOWNLOADS_PENDING',
  'DISCONNECTED',
  'PAUSED',
  'NOT_ALLOWED',
  'INVALID',
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

export type StartupNotice =
  | {
      id: string;
      kind: 'recovered-config';
      file: 'profiles' | 'settings' | 'trustedHosts' | 'transferJournal';
      backupPath: string;
      message: string;
    }
  | {
      /** Partial files from an earlier run, recorded in the app's journal. */
      id: string;
      kind: 'orphan-partials';
      message: string;
      paths: string[];
    };

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
    resolveQuit(requestId: string, choice: QuitChoice): Promise<IpcResult<null>>;
    onQuitRequest(listener: (request: QuitRequest) => void): () => void;
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
    /** cancelDownloads: confirm cancelling pending downloads (else DOWNLOADS_PENDING). */
    connect(
      profileId: string,
      cancelDownloads?: boolean,
    ): Promise<IpcResult<{ sessionId: string }>>;
    cancel(sessionId: string): Promise<IpcResult<null>>;
    disconnect(sessionId: string, cancelDownloads?: boolean): Promise<IpcResult<null>>;
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
    /**
     * Version 2, outside SPEC.md: the one deliberate exception to spec 7.2.
     * Returns the bytes of a remote image (capped, magic-byte checked) for an
     * in-memory preview. The full image is not written to disk.
     */
    previewImage(
      sessionId: string,
      requestId: string,
      path: string,
    ): Promise<IpcResult<ImagePreview>>;
    cancelPreview(sessionId: string, requestId: string): Promise<IpcResult<null>>;
    /**
     * Grid thumbnail. Same cap and magic-byte check as previewImage, but the
     * bytes are a downsized PNG (or a small SVG), and main may serve them from
     * the local thumbnail cache. `size` is small or large.
     */
    thumbnail(
      sessionId: string,
      requestId: string,
      path: string,
      size: 'small' | 'large',
    ): Promise<IpcResult<Thumbnail>>;
    cancelThumbnail(sessionId: string, requestId: string): Promise<IpcResult<null>>;
  };
  previews: {
    /** Delete every cached thumbnail. Does not touch profiles, keys or downloads. */
    clearCache(): Promise<IpcResult<null>>;
  };
  downloads: {
    list(): Promise<IpcResult<DownloadsSnapshot>>;
    /** Main shows the native Save/folder dialog; the renderer never names a local path. */
    chooseDestinationAndEnqueue(
      sessionId: string,
      paths: string[],
    ): Promise<IpcResult<EnqueueResult>>;
    resolvePlan(planId: string, decisions: PlanDecision[]): Promise<IpcResult<EnqueueResult>>;
    cancelPlan(planId: string): Promise<IpcResult<null>>;
    resolveConflict(
      jobId: string,
      promptId: string,
      choice: CollisionChoice,
    ): Promise<IpcResult<null>>;
    cancel(jobId: string): Promise<IpcResult<null>>;
    retry(jobId: string): Promise<IpcResult<{ jobId: string }>>;
    reveal(jobId: string): Promise<IpcResult<null>>;
    retryCleanup(jobId: string): Promise<IpcResult<null>>;
    continue(): Promise<IpcResult<null>>;
    cancelAll(): Promise<IpcResult<null>>;
    clearFinished(): Promise<IpcResult<null>>;
    resolveOrphans(action: 'delete' | 'keep'): Promise<IpcResult<{ failed: string[] }>>;
    onChange(listener: (snapshot: DownloadsSnapshot) => void): () => void;
  };
}
