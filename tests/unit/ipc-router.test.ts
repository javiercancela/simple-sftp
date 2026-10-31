import { describe, expect, it } from 'vitest';
import { BrowseService } from '../../src/main/connections/browse-service';
import { PreviewService } from '../../src/main/connections/preview-service';
import {
  ConnectionManager,
  StaleRequestError,
} from '../../src/main/connections/connection-manager';
import { DownloadService } from '../../src/main/downloads/download-service';
import { TransferJournal } from '../../src/main/downloads/journal';
import { TrustStore } from '../../src/main/connections/trust-store';
import { createIpcRouter, type SenderInfo } from '../../src/main/ipc/router';
import { SettingsStore } from '../../src/main/platform/settings-store';
import { ProfileStore } from '../../src/main/profiles/profile-store';
import { IPC, PayloadSchemas } from '../../src/shared/ipc-contract';
import { useTempDir } from './helpers';

const APP_URL = 'file:///app/.vite/renderer/main_window/index.html';
const TRUSTED: SenderInfo = { frameUrl: APP_URL, isMainFrame: true, webContentsId: 1 };
const RANDOM_UUID = '3f2a7c1e-9b4d-4e8a-a1c2-0d9e8f7a6b5c';

const input = {
  name: 'Box',
  host: '127.0.0.1',
  port: 2222,
  username: 'me',
  authMode: 'privateKey',
  privateKeyPath: '/home/me/.ssh/id_ed25519',
  certificatePath: null,
  initialRemoteDirectory: null,
  downloadDirectory: null,
};

async function setup(dir: string) {
  const profiles = new ProfileStore(dir);
  const settings = new SettingsStore(dir);
  const trust = new TrustStore(dir);
  const journal = new TransferJournal(dir);
  await Promise.all([profiles.load(), settings.load(), trust.load(), journal.load()]);
  const emitted: unknown[] = [];
  const connections = new ConnectionManager({
    getProfile: (id) => profiles.get(id),
    trust,
    emit: (s) => emitted.push(s),
  });
  const chosen: string[] = [];
  const dialogs: string[] = [];
  const downloads = new DownloadService({
    connection: () => {
      const s = connections.getSnapshot();
      return {
        sessionId: s.sessionId,
        profileId: s.profileId,
        profileName: s.profileName,
        connected: s.state === 'connected',
      };
    },
    getSession: (id) => connections.getSession(id),
    getProfile: (id) => profiles.get(id),
    saveDialog: (p) => {
      dialogs.push(`save:${p}`);
      return Promise.resolve(null);
    },
    chooseDirectory: (p) => {
      dialogs.push(`dir:${p}`);
      return Promise.resolve(null);
    },
    defaultDownloadDir: () => dir,
    journal,
    platform: 'linux',
    emit: () => undefined,
    reveal: (p) => dialogs.push(`reveal:${p}`),
  });
  const router = createIpcRouter({
    profiles,
    settings,
    trust,
    connections,
    browse: new BrowseService({ getSession: (id) => connections.getSession(id) }),
    preview: new PreviewService({ getSession: (id) => connections.getSession(id) }),
    downloads,
    resolveQuit: () => Promise.reject(new StaleRequestError('Quit request')),
    appInfo: () => ({
      name: 'SimpleSFTP',
      version: '0',
      electron: '0',
      platform: 'linux',
      arch: 'x64',
    }),
    chooseFile: async (kind) => {
      chosen.push(kind);
      return { canceled: true };
    },
    notices: [],
    isTrustedSender: (s) => s.webContentsId === 1 && s.isMainFrame && s.frameUrl === APP_URL,
  });
  return { router, profiles, settings, connections, chosen, emitted, dialogs };
}

describe('IPC router', () => {
  const tmp = useTempDir();

  it('exposes exactly the allowlisted channels, each with a payload schema', async () => {
    const { router } = await setup(await tmp());
    expect([...router.channels].sort()).toEqual(Object.values(IPC).sort());
    expect(Object.keys(PayloadSchemas).sort()).toEqual(Object.values(IPC).sort());
  });

  it('rejects unknown channels and untrusted senders before running anything', async () => {
    const { router, chosen } = await setup(await tmp());
    expect(await router.invoke('fs.readFile', TRUSTED, { path: '/etc/passwd' })).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_CHANNEL' },
    });
    for (const bad of [
      { ...TRUSTED, webContentsId: 2 },
      { ...TRUSTED, isMainFrame: false },
      { ...TRUSTED, frameUrl: 'https://evil.example/' },
    ]) {
      const r = await router.invoke(IPC.credentialsChooseFile, bad, { kind: 'privateKey' });
      expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    expect(chosen).toEqual([]);
  });

  it.each([
    [IPC.profilesList, { extra: 1 }],
    [IPC.profilesDelete, { id: 'not-a-uuid' }],
    [IPC.profilesDelete, { id: RANDOM_UUID, extra: true }],
    [IPC.credentialsChooseFile, { kind: 'anyFile' }],
    [IPC.connectionsConnect, {}],
    [IPC.passphraseSubmit, { challengeId: RANDOM_UUID, passphrase: '' }],
    [IPC.passphraseSubmit, { challengeId: RANDOM_UUID, passphrase: 'x'.repeat(2000) }],
    [IPC.trustAccept, 'string payload'],
    [IPC.remoteList, { sessionId: RANDOM_UUID, requestId: RANDOM_UUID, path: 'relative/dir' }],
    [IPC.remoteList, { sessionId: RANDOM_UUID, requestId: RANDOM_UUID, path: '/a\u0000b' }],
    [
      IPC.remoteList,
      { sessionId: RANDOM_UUID, requestId: RANDOM_UUID, path: '/' + 'a'.repeat(5000) },
    ],
    [IPC.remoteList, { sessionId: RANDOM_UUID, requestId: 'r1', path: '/' }],
    [
      IPC.remoteList,
      { sessionId: RANDOM_UUID, requestId: RANDOM_UUID, path: '/', recursive: true },
    ],
    [IPC.remoteCancel, { sessionId: RANDOM_UUID }],
    [IPC.remotePreviewImage, { sessionId: RANDOM_UUID, requestId: RANDOM_UUID, path: 'x.png' }],
    [IPC.remotePreviewImage, { sessionId: 'abc', requestId: RANDOM_UUID, path: '/x.png' }],
    [
      IPC.remotePreviewImage,
      { sessionId: RANDOM_UUID, requestId: RANDOM_UUID, path: '/x.png', maxBytes: 1e9 },
    ],
    [
      IPC.remotePreviewImage,
      { sessionId: RANDOM_UUID, requestId: RANDOM_UUID, path: '/\u0000.png' },
    ],
    [IPC.remoteCancelPreview, { sessionId: RANDOM_UUID, requestId: 7 }],
  ])('%s rejects malformed payload %j', async (channel, payload) => {
    const { router } = await setup(await tmp());
    expect(await router.invoke(channel, TRUSTED, payload)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
  });

  it('returns field errors for invalid profiles and a result envelope on success', async () => {
    const { router } = await setup(await tmp());
    const bad = await router.invoke(IPC.profilesSave, TRUSTED, {
      input: { ...input, port: 0, host: 'a b' },
    });
    expect(bad).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', fields: { port: expect.any(String), host: expect.any(String) } },
    });
    const good = await router.invoke(IPC.profilesSave, TRUSTED, { input });
    expect(good.ok).toBe(true);
    const list = await router.invoke(IPC.profilesList, TRUSTED, undefined);
    expect(list).toMatchObject({ ok: true, value: [{ name: 'Box' }] });
  });

  it('NOT_FOUND for missing profiles; deleting the last selected profile clears the selection', async () => {
    const { router, settings } = await setup(await tmp());
    expect(await router.invoke(IPC.profilesDelete, TRUSTED, { id: RANDOM_UUID })).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(
      await router.invoke(IPC.connectionsConnect, TRUSTED, { profileId: RANDOM_UUID }),
    ).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const saved = await router.invoke(IPC.profilesSave, TRUSTED, { input });
    const id = (saved as { value: { id: string } }).value.id;
    await router.invoke(IPC.settingsUpdate, TRUSTED, { lastSelectedProfileId: id });
    expect(settings.get().lastSelectedProfileId).toBe(id);
    expect(await router.invoke(IPC.profilesDelete, TRUSTED, { id })).toEqual({
      ok: true,
      value: null,
    });
    expect(settings.get().lastSelectedProfileId).toBeNull();
  });

  it('settings updates are validated (theme enum, sidebar bounds, no unknown keys)', async () => {
    const { router, settings } = await setup(await tmp());
    for (const patch of [{ theme: 'neon' }, { sidebarWidth: 5000 }, { secret: 'x' }]) {
      expect(await router.invoke(IPC.settingsUpdate, TRUSTED, patch)).toMatchObject({
        error: { code: 'INVALID_PAYLOAD' },
      });
    }
    expect(
      await router.invoke(IPC.settingsUpdate, TRUSTED, { theme: 'dark', sidebarWidth: 300 }),
    ).toMatchObject({
      ok: true,
      value: { theme: 'dark', sidebarWidth: 300 },
    });
    expect(settings.get().theme).toBe('dark');
  });

  it('challenge replies that do not match an outstanding challenge are STALE', async () => {
    const { router } = await setup(await tmp());
    for (const [ch, p] of [
      [IPC.trustAccept, { challengeId: RANDOM_UUID }],
      [IPC.trustReject, { challengeId: RANDOM_UUID }],
      [IPC.passphraseSubmit, { challengeId: RANDOM_UUID, passphrase: 'pw' }],
      [IPC.passphraseCancel, { challengeId: RANDOM_UUID }],
      [IPC.connectionsCancel, { sessionId: RANDOM_UUID }],
      [IPC.connectionsDisconnect, { sessionId: RANDOM_UUID }],
    ] as const) {
      expect(await router.invoke(ch, TRUSTED, p), ch).toMatchObject({
        ok: false,
        error: { code: 'STALE' },
      });
    }
  });

  it('remote.list needs the current connected session; unknown cancels are STALE', async () => {
    const { router } = await setup(await tmp());
    expect(
      await router.invoke(IPC.remoteList, TRUSTED, {
        sessionId: RANDOM_UUID,
        requestId: RANDOM_UUID,
        path: '/etc',
      }),
    ).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } });
    expect(
      await router.invoke(IPC.remoteCancel, TRUSTED, {
        sessionId: RANDOM_UUID,
        requestId: RANDOM_UUID,
      }),
    ).toMatchObject({ ok: false, error: { code: 'STALE' } });
  });

  it('remote.previewImage needs the current connected session; unknown preview cancels are STALE', async () => {
    const { router } = await setup(await tmp());
    expect(
      await router.invoke(IPC.remotePreviewImage, TRUSTED, {
        sessionId: RANDOM_UUID,
        requestId: RANDOM_UUID,
        path: '/srv/a.png',
      }),
    ).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } });
    expect(
      await router.invoke(IPC.remoteCancelPreview, TRUSTED, {
        sessionId: RANDOM_UUID,
        requestId: RANDOM_UUID,
      }),
    ).toMatchObject({ ok: false, error: { code: 'STALE' } });
  });

  it('removing an unknown trusted host is NOT_FOUND', async () => {
    const { router } = await setup(await tmp());
    expect(await router.invoke(IPC.trustedHostsRemove, TRUSTED, { key: 'nope:22' })).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('downloads: the renderer can only name remote files; never a local path; stale IDs are refused', async () => {
    const { router, dialogs } = await setup(await tmp());
    const call = (ch: string, p: unknown) => router.invoke(ch, TRUSTED, p);
    const S = RANDOM_UUID;
    // Extra keys (a local destination) and malformed remote paths never pass.
    for (const bad of [
      { sessionId: S, paths: ['/srv/a.txt'], destination: '/tmp/evil' },
      { sessionId: S, paths: ['/srv/a.txt'], localPath: '/etc/passwd' },
      { sessionId: S, paths: ['relative.txt'] },
      { sessionId: S, paths: ['/srv/a\0.txt'] },
      { sessionId: S, paths: [] },
      { sessionId: S, paths: Array.from({ length: 1001 }, (_, i) => `/f${i}`) },
      { sessionId: 'not-a-uuid', paths: ['/srv/a.txt'] },
      { sessionId: S, paths: '/srv/a.txt' },
    ]) {
      expect(await call(IPC.downloadsEnqueue, bad)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PAYLOAD' },
      });
    }
    // Well formed, but not connected: no dialog is shown.
    expect(await call(IPC.downloadsEnqueue, { sessionId: S, paths: ['/srv/a.txt'] })).toMatchObject(
      {
        ok: false,
        error: { code: 'DISCONNECTED' },
      },
    );
    expect(dialogs).toEqual([]);
    // Unknown or stale IDs.
    expect(await call(IPC.downloadsCancel, { jobId: S })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await call(IPC.downloadsRetry, { jobId: S })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await call(IPC.downloadsReveal, { jobId: S })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await call(IPC.downloadsRetryCleanup, { jobId: S })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await call(IPC.downloadsResolvePlan, { planId: S, decisions: [] })).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    });
    expect(await call(IPC.downloadsCancelPlan, { planId: S })).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    });
    expect(
      await call(IPC.downloadsResolveConflict, { jobId: S, promptId: S, choice: 'replace' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    });
    expect(
      await call(IPC.downloadsResolveConflict, { jobId: S, promptId: S, choice: 'overwrite' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
    expect(await call(IPC.downloadsContinue, undefined)).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    });
    expect(await call(IPC.downloadsResolveOrphans, { action: 'delete' })).toMatchObject({
      ok: false,
      error: { code: 'STALE' },
    });
    expect(await call(IPC.downloadsResolveOrphans, { action: 'rm -rf' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
    expect(await call(IPC.appResolveQuit, { requestId: S, choice: 'cancelAndQuit' })).toMatchObject(
      { ok: false, error: { code: 'STALE' } },
    );
    expect(await call(IPC.downloadsList, undefined)).toMatchObject({
      ok: true,
      value: { jobs: [], pause: null, conflict: null },
    });
    // Rename decisions carry a name, never a path; resolvePlan validates it in main.
    expect(
      await call(IPC.downloadsResolvePlan, {
        planId: S,
        decisions: [{ itemId: S, action: 'rename', name: 'x', path: '/tmp/x' }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(dialogs).toEqual([]);
  });
});
