import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionSnapshot } from '../shared/connection';
import type { StartupNotice } from '../shared/ipc-contract';
import type { Profile } from '../shared/profiles';
import type { Settings, Theme } from '../shared/settings';
import { api } from './api';
import { Browser } from './browser/Browser';
import { PassphraseDialog, TrustDialog } from './components/ChallengeDialogs';
import { ErrorPanel } from './components/ErrorPanel';
import { ProfileDialog } from './components/ProfileDialog';
import { ConfirmDeleteDialog, SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';

type Modal =
  | { kind: 'profile'; profile: Profile | null }
  | { kind: 'delete'; profile: Profile }
  | { kind: 'settings' }
  | null;

const EMPTY: ConnectionSnapshot = {
  revision: -1,
  sessionId: null,
  profileId: null,
  profileName: null,
  state: 'disconnected',
  challenge: null,
  error: null,
  hostKey: null,
  remoteHome: null,
};

export function App(): React.JSX.Element {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [snap, setSnap] = useState<ConnectionSnapshot>(EMPTY);
  const [notices, setNotices] = useState<StartupNotice[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [dismissedRev, setDismissedRev] = useState(-1);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastRev = useRef(-1);
  // The profile we were last browsing, to show a distinct disconnected state.
  const [lastBrowsed, setLastBrowsed] = useState<{ id: string; name: string } | null>(null);
  if (
    snap.state === 'connected' &&
    snap.profileId &&
    snap.profileName &&
    (lastBrowsed?.id !== snap.profileId || lastBrowsed.name !== snap.profileName)
  )
    setLastBrowsed({ id: snap.profileId, name: snap.profileName });

  const applySnap = useCallback((s: ConnectionSnapshot) => {
    // Drop out-of-order events (spec 9.4).
    if (s.revision <= lastRev.current) return;
    lastRev.current = s.revision;
    setSnap(s);
  }, []);

  useEffect(() => {
    const off = api().connections.onState(applySnap);
    void (async () => {
      const [p, st, c, n] = await Promise.all([
        api().profiles.list(),
        api().settings.get(),
        api().connections.getState(),
        api().app.getNotices(),
      ]);
      if (p.ok) setProfiles(p.value);
      if (st.ok) {
        setSettings(st.value);
        setSidebarWidth(st.value.sidebarWidth);
      }
      if (c.ok) applySnap(c.value);
      if (n.ok) setNotices(n.value);
    })();
    return off;
  }, [applySnap]);

  const selectedId =
    settings?.lastSelectedProfileId &&
    profiles?.some((p) => p.id === settings.lastSelectedProfileId)
      ? settings.lastSelectedProfileId
      : null;
  const selected = profiles?.find((p) => p.id === selectedId) ?? null;

  const updateSettings = async (
    patch: Parameters<ReturnType<typeof api>['settings']['update']>[0],
  ): Promise<void> => {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as Partial<Settings>;
    setSettings((s) => (s ? { ...s, ...defined } : s));
    const r = await api().settings.update(patch);
    if (r.ok) setSettings(r.value);
  };
  const select = (id: string): void => void updateSettings({ lastSelectedProfileId: id });
  const reloadProfiles = async (): Promise<void> => {
    const r = await api().profiles.list();
    if (r.ok) setProfiles(r.value);
  };

  const connect = async (id: string): Promise<void> => {
    setActionError(null);
    if (id !== selectedId) select(id);
    const r = await api().connections.connect(id);
    if (!r.ok) setActionError(r.error.message);
  };

  const duplicate = async (): Promise<void> => {
    if (!selected) return;
    const r = await api().profiles.duplicate(selected.id);
    if (r.ok) {
      await reloadProfiles();
      select(r.value.id);
    } else setActionError(r.error.message);
  };

  if (!profiles || !settings) return <div className="loading">Loading…</div>;

  const ch = snap.challenge;
  const showError =
    snap.error &&
    snap.revision !== dismissedRev &&
    (snap.state === 'failed' || snap.state === 'disconnected');

  return (
    <div className="app" style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}>
      <Sidebar
        profiles={profiles}
        selectedId={selectedId}
        activeId={snap.state === 'connected' ? snap.profileId : null}
        width={sidebarWidth}
        onSelect={select}
        onConnect={(id) => void connect(id)}
        onAdd={() => setModal({ kind: 'profile', profile: null })}
        onEdit={() => selected && setModal({ kind: 'profile', profile: selected })}
        onDuplicate={() => void duplicate()}
        onDelete={() => selected && setModal({ kind: 'delete', profile: selected })}
        onSettings={() => setModal({ kind: 'settings' })}
        onResize={(w, commit) => {
          setSidebarWidth(w);
          if (commit) void updateSettings({ sidebarWidth: w });
        }}
      />
      <main className="main">
        <TopBar
          snapshot={snap}
          selected={selected}
          onConnect={() => selected && void connect(selected.id)}
          onCancel={() => snap.sessionId && void api().connections.cancel(snap.sessionId)}
          onDisconnect={() => snap.sessionId && void api().connections.disconnect(snap.sessionId)}
        />
        {notices.map((n) => (
          <section key={n.id} className="notice" role="status" data-testid="recovery-notice">
            <p>{n.message}</p>
            <button
              type="button"
              onClick={() => {
                void api().app.dismissNotice(n.id);
                setNotices((ns) => ns.filter((x) => x.id !== n.id));
              }}
            >
              Dismiss
            </button>
          </section>
        ))}
        {actionError && (
          <p className="form-error" role="alert">
            {actionError}
          </p>
        )}
        {showError && snap.error && (
          <ErrorPanel error={snap.error} onDismiss={() => setDismissedRev(snap.revision)} />
        )}
        <section className="panel" aria-label="Remote files">
          {profiles.length === 0 ? (
            <div className="empty-state" data-testid="empty-state">
              <h2>Add your first server</h2>
              <p>
                Save an SFTP server with your SSH key (and certificate, if your server uses one),
                then connect.
              </p>
              <button
                type="button"
                className="primary"
                onClick={() => setModal({ kind: 'profile', profile: null })}
              >
                Add server
              </button>
            </div>
          ) : snap.state === 'connected' && snap.sessionId ? (
            <Browser
              key={snap.sessionId}
              session={{
                sessionId: snap.sessionId,
                home: snap.remoteHome,
                initialDir:
                  profiles.find((p) => p.id === snap.profileId)?.initialRemoteDirectory ?? null,
              }}
            />
          ) : (snap.state === 'disconnected' || snap.state === 'failed') &&
            lastBrowsed &&
            selected?.id === lastBrowsed.id ? (
            <div className="empty-state" data-testid="browser-state-disconnected">
              <h2>
                {snap.error?.code === 'CONNECTION_LOST'
                  ? `Connection to ${lastBrowsed.name} was lost`
                  : `Disconnected from ${lastBrowsed.name}`}
              </h2>
              <p>Files can't be browsed while disconnected.</p>
              <button
                type="button"
                className="primary"
                onClick={() => void connect(lastBrowsed.id)}
              >
                Reconnect
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <p>
                {selected
                  ? `Select Connect to open ${selected.name}.`
                  : 'Select a server on the left.'}
              </p>
            </div>
          )}
        </section>
      </main>

      {modal?.kind === 'profile' && (
        <ProfileDialog
          profile={modal.profile}
          onClose={() => setModal(null)}
          onSaved={(p) => {
            setModal(null);
            void reloadProfiles().then(() => select(p.id));
          }}
        />
      )}
      {modal?.kind === 'delete' && (
        <ConfirmDeleteDialog
          name={modal.profile.name}
          onClose={() => setModal(null)}
          onConfirm={() => {
            const id = modal.profile.id;
            setModal(null);
            void api()
              .profiles.delete(id)
              .then(async (r) => {
                if (!r.ok) setActionError(r.error.message);
                await reloadProfiles();
                const st = await api().settings.get();
                if (st.ok) setSettings(st.value);
              });
          }}
        />
      )}
      {modal?.kind === 'settings' && (
        <SettingsDialog
          theme={settings.theme}
          onTheme={(t: Theme) => void updateSettings({ theme: t })}
          onClose={() => setModal(null)}
        />
      )}
      {ch?.kind === 'hostTrust' && snap.state === 'awaitingHostTrust' && (
        <TrustDialog key={ch.challengeId} challenge={ch} />
      )}
      {ch?.kind === 'passphrase' && snap.state === 'awaitingPassphrase' && (
        <PassphraseDialog key={ch.challengeId} challenge={ch} />
      )}
    </div>
  );
}
