import type { ConnectionSnapshot, ConnectionState } from '../../shared/connection';
import type { Profile } from '../../shared/profiles';

const STATUS: Record<ConnectionState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  awaitingHostTrust: 'Waiting for host key confirmation',
  awaitingPassphrase: 'Waiting for passphrase',
  connected: 'Connected',
  disconnecting: 'Disconnecting…',
  failed: 'Connection failed',
};

export function TopBar({
  snapshot,
  selected,
  onConnect,
  onCancel,
  onDisconnect,
}: {
  snapshot: ConnectionSnapshot;
  selected: Profile | null;
  onConnect: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
}): React.JSX.Element {
  const s = snapshot.state;
  const busy = s === 'connecting' || s === 'awaitingHostTrust' || s === 'awaitingPassphrase';
  const title = snapshot.profileName ?? selected?.name ?? 'No server selected';
  const showsOther =
    snapshot.state === 'connected' && selected && snapshot.profileId !== selected.id;
  return (
    <header className="topbar" data-testid="topbar">
      <div className="topbar-title">
        <h1 data-testid="active-server">{title}</h1>
        <span
          className={`status status-${s}`}
          role="status"
          aria-live="polite"
          data-testid="connection-status"
        >
          {STATUS[s]}
        </span>
        {s === 'connected' && snapshot.remoteHome && (
          <span
            className="remote-home mono"
            data-testid="remote-home"
            title="Server default folder"
          >
            {snapshot.remoteHome}
          </span>
        )}
      </div>
      <div className="topbar-actions">
        {busy ? (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        ) : s === 'connected' ? (
          <>
            {showsOther && (
              <button type="button" onClick={onConnect}>
                Connect to {selected.name}
              </button>
            )}
            <button type="button" onClick={onDisconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            onClick={onConnect}
            disabled={!selected || s === 'disconnecting'}
          >
            Connect
          </button>
        )}
      </div>
    </header>
  );
}
