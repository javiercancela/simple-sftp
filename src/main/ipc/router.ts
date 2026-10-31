// Allowlisted IPC router: sender check, strict payload validation, state
// validation via the services, and a uniform result envelope (spec 9.4).
// Electron-free so it can be unit tested; handlers.ts wires it to ipcMain.
import { ZodError } from 'zod';
import type { ConnectionSnapshot } from '../../shared/connection';
import {
  IPC,
  PayloadSchemas,
  type AppInfo,
  type ChooseFileResult,
  type InvokeChannel,
  type IpcResult,
  type StartupNotice,
  type TrustedHostEntry,
} from '../../shared/ipc-contract';
import type { Profile } from '../../shared/profiles';
import type { Settings } from '../../shared/settings';
import { StaleRequestError, type ConnectionManager } from '../connections/connection-manager';
import { isTransportError } from '../connections/errors';
import type { BrowseService } from '../connections/browse-service';
import { DownloadRequestError, type DownloadService } from '../downloads/download-service';
import type { CollisionChoice, PlanDecision } from '../../shared/downloads';
import type { QuitChoice } from '../../shared/ipc-contract';
import type { TrustStore } from '../connections/trust-store';
import type { SettingsStore } from '../platform/settings-store';
import {
  ProfileNotFoundError,
  ProfileValidationError,
  type ProfileStore,
} from '../profiles/profile-store';

export interface SenderInfo {
  /** URL of the frame that sent the message. */
  frameUrl: string;
  /** True when the sender is the top-level frame. */
  isMainFrame: boolean;
  /** webContents id of the sender. */
  webContentsId: number;
}

export interface RouterServices {
  profiles: ProfileStore;
  settings: SettingsStore;
  trust: TrustStore;
  connections: ConnectionManager;
  browse: BrowseService;
  downloads: DownloadService;
  /** Answer to a quit prompt (main owns the quit flow). */
  resolveQuit(requestId: string, choice: QuitChoice): Promise<void>;
  appInfo(): AppInfo;
  chooseFile(kind: 'privateKey' | 'certificate' | 'downloadDirectory'): Promise<ChooseFileResult>;
  notices: StartupNotice[];
  /** Decides whether a sender may call us at all. */
  isTrustedSender(sender: SenderInfo): boolean;
  onSettingsChanged?(settings: Settings): void;
  log?(message: string): void;
}

type Handler = (payload: never) => Promise<unknown> | unknown;

const ok = <T>(value: T): IpcResult<T> => ({ ok: true, value });
const fail = (
  code: string,
  message: string,
  fields?: Record<string, string>,
): IpcResult<never> => ({
  ok: false,
  error: fields ? { code, message, fields } : { code, message },
});

export function createIpcRouter(s: RouterServices) {
  const handlers: Record<InvokeChannel, Handler> = {
    [IPC.appGetInfo]: () => s.appInfo(),
    [IPC.appGetNotices]: () => s.notices,
    [IPC.appDismissNotice]: (p: { noticeId: string }) => {
      const i = s.notices.findIndex((n) => n.id === p.noticeId);
      if (i === -1) throw new NotFound();
      s.notices.splice(i, 1);
      return null;
    },
    [IPC.profilesList]: (): Profile[] => s.profiles.list(),
    [IPC.profilesSave]: (p: { id?: string; input: unknown }) => s.profiles.save(p.id, p.input),
    [IPC.profilesDuplicate]: (p: { id: string }) => s.profiles.duplicate(p.id),
    [IPC.profilesDelete]: async (p: { id: string }) => {
      await s.profiles.delete(p.id);
      const st = s.settings.get();
      if (st.lastSelectedProfileId === p.id)
        await s.settings.update({ lastSelectedProfileId: null });
      return null;
    },
    [IPC.credentialsChooseFile]: (p: {
      kind: 'privateKey' | 'certificate' | 'downloadDirectory';
    }) => s.chooseFile(p.kind),
    [IPC.settingsGet]: (): Settings => s.settings.get(),
    [IPC.settingsUpdate]: async (p: unknown) => {
      const next = await s.settings.update(p);
      s.onSettingsChanged?.(next);
      return next;
    },
    [IPC.connectionsGetState]: (): ConnectionSnapshot => s.connections.getSnapshot(),
    [IPC.connectionsConnect]: async (p: { profileId: string; cancelDownloads?: boolean }) => {
      if (!s.profiles.get(p.profileId)) throw new NotFound();
      // Switching servers with pending downloads needs explicit confirmation.
      if (s.downloads.connectNeedsConfirmation(p.profileId)) {
        if (!p.cancelDownloads) throw new DownloadsPendingError();
        await s.downloads.cancelAll();
      }
      return { sessionId: await s.connections.connect(p.profileId) };
    },
    [IPC.connectionsCancel]: (p: { sessionId: string }) => {
      s.connections.cancel(p.sessionId);
      return null;
    },
    [IPC.connectionsDisconnect]: async (p: { sessionId: string; cancelDownloads?: boolean }) => {
      if (s.connections.getSnapshot().sessionId !== p.sessionId)
        throw new StaleRequestError('Session');
      if (s.downloads.hasPending()) {
        if (!p.cancelDownloads) throw new DownloadsPendingError();
        await s.downloads.cancelAll();
      }
      await s.connections.disconnect(p.sessionId);
      return null;
    },
    [IPC.trustAccept]: (p: { challengeId: string }) => {
      s.connections.acceptTrust(p.challengeId);
      return null;
    },
    [IPC.trustReject]: (p: { challengeId: string }) => {
      s.connections.rejectTrust(p.challengeId);
      return null;
    },
    [IPC.passphraseSubmit]: (p: { challengeId: string; passphrase: string }) => {
      s.connections.submitPassphrase(p.challengeId, p.passphrase);
      return null;
    },
    [IPC.passphraseCancel]: (p: { challengeId: string }) => {
      s.connections.cancelPassphrase(p.challengeId);
      return null;
    },
    [IPC.trustedHostsList]: (): TrustedHostEntry[] => s.trust.list(),
    [IPC.trustedHostsRemove]: async (p: { key: string }) => {
      if (!(await s.trust.remove(p.key))) throw new NotFound();
      return null;
    },
    [IPC.remoteList]: (p: { sessionId: string; requestId: string; path: string }) =>
      s.browse.list(p.sessionId, p.requestId, p.path),
    [IPC.remoteCancel]: (p: { sessionId: string; requestId: string }) => {
      if (!s.browse.cancel(p.sessionId, p.requestId)) throw new StaleRequestError('Request');
      return null;
    },
    [IPC.downloadsList]: () => s.downloads.getSnapshot(),
    [IPC.downloadsEnqueue]: (p: { sessionId: string; paths: string[] }) =>
      s.downloads.chooseDestinationAndEnqueue(p.sessionId, p.paths),
    [IPC.downloadsResolvePlan]: (p: { planId: string; decisions: PlanDecision[] }) =>
      s.downloads.resolvePlan(p.planId, p.decisions),
    [IPC.downloadsCancelPlan]: (p: { planId: string }) => {
      s.downloads.cancelPlan(p.planId);
      return null;
    },
    [IPC.downloadsResolveConflict]: (p: {
      jobId: string;
      promptId: string;
      choice: CollisionChoice;
    }) => {
      s.downloads.resolveConflict(p.jobId, p.promptId, p.choice);
      return null;
    },
    [IPC.downloadsCancel]: (p: { jobId: string }) => {
      s.downloads.cancel(p.jobId);
      return null;
    },
    [IPC.downloadsRetry]: (p: { jobId: string }) => ({ jobId: s.downloads.retry(p.jobId) }),
    [IPC.downloadsReveal]: (p: { jobId: string }) => {
      s.downloads.reveal(p.jobId);
      return null;
    },
    [IPC.downloadsRetryCleanup]: async (p: { jobId: string }) => {
      await s.downloads.retryCleanup(p.jobId);
      return null;
    },
    [IPC.downloadsContinue]: () => {
      s.downloads.continueQueue();
      return null;
    },
    [IPC.downloadsCancelAll]: async () => {
      await s.downloads.cancelAll();
      return null;
    },
    [IPC.downloadsClearFinished]: () => {
      s.downloads.clearFinished();
      return null;
    },
    [IPC.downloadsResolveOrphans]: async (p: { action: 'delete' | 'keep' }) => {
      const r = await s.downloads.resolveOrphans(p.action);
      const i = s.notices.findIndex((n) => n.kind === 'orphan-partials');
      if (i !== -1) s.notices.splice(i, 1);
      return r;
    },
    [IPC.appResolveQuit]: async (p: { requestId: string; choice: QuitChoice }) => {
      await s.resolveQuit(p.requestId, p.choice);
      return null;
    },
  };

  const channels = new Set<string>(Object.keys(handlers));

  async function invoke(
    channel: string,
    sender: SenderInfo,
    payload: unknown,
  ): Promise<IpcResult<unknown>> {
    if (!channels.has(channel)) return fail('UNKNOWN_CHANNEL', 'Unknown operation.');
    if (!s.isTrustedSender(sender)) return fail('FORBIDDEN', 'Request from an untrusted sender.');
    const schema = PayloadSchemas[channel as InvokeChannel];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return fail('INVALID_PAYLOAD', 'Malformed request.');
    try {
      const value = await handlers[channel as InvokeChannel](parsed.data as never);
      return ok(value);
    } catch (err) {
      return mapError(err, s.log);
    }
  }

  return { invoke, channels: [...channels] as InvokeChannel[] };
}

class NotFound extends Error {}

export class DownloadsPendingError extends Error {}

function mapError(err: unknown, log?: (m: string) => void): IpcResult<never> {
  if (err instanceof ProfileValidationError)
    return fail('VALIDATION', 'Please fix the highlighted fields.', err.fields);
  if (err instanceof ProfileNotFoundError || err instanceof NotFound)
    return fail('NOT_FOUND', 'That item no longer exists.');
  if (err instanceof StaleRequestError) return fail('STALE', 'That request is no longer current.');
  if (err instanceof DownloadRequestError) return fail(err.code, err.message);
  if (err instanceof DownloadsPendingError)
    return fail('DOWNLOADS_PENDING', 'Downloads are still in progress.');
  if (err instanceof ZodError) return fail('INVALID_PAYLOAD', 'Malformed request.');
  if (isTransportError(err)) return fail(err.code, err.message);
  const e = err as NodeJS.ErrnoException;
  if (typeof e?.code === 'string' && /^E[A-Z]+$/.test(e.code)) {
    return fail('STORAGE', 'Could not save settings to disk.');
  }
  log?.(`ipc internal error: ${(err as Error)?.message ?? String(err)}`);
  return fail('INTERNAL', 'Something went wrong.');
}
