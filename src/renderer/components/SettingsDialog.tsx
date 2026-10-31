import { useEffect, useState } from 'react';
import type { TrustedHostEntry } from '../../shared/ipc-contract';
import type { Theme } from '../../shared/settings';
import { api } from '../api';
import { Dialog } from './Dialog';

export function SettingsDialog({
  theme,
  onTheme,
  onClose,
}: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [hosts, setHosts] = useState<TrustedHostEntry[] | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [cacheNote, setCacheNote] = useState<string | null>(null);
  const load = (): void => {
    void api()
      .trustedHosts.list()
      .then((r) => r.ok && setHosts(r.value));
  };
  useEffect(load, []);
  return (
    <Dialog
      title="Settings"
      onClose={onClose}
      initialFocusId="theme-select"
      testId="settings-dialog"
    >
      <div className="field">
        <label htmlFor="theme-select">Theme</label>
        <select id="theme-select" value={theme} onChange={(e) => onTheme(e.target.value as Theme)}>
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <h3>Preview cache</h3>
      <p className="hint">
        Small copies of remote images, stored on this computer for the current view. Clearing it
        does not change servers, keys or downloads.
      </p>
      <div className="dialog-actions">
        <button
          type="button"
          data-testid="clear-preview-cache"
          onClick={() => {
            setCacheNote(null);
            void api()
              .previews.clearCache()
              .then((r) => setCacheNote(r.ok ? 'Preview cache cleared.' : r.error.message));
          }}
        >
          Clear preview cache
        </button>
      </div>
      {cacheNote && (
        <p className="hint" role="status" data-testid="preview-cache-note">
          {cacheNote}
        </p>
      )}
      <h3>Trusted hosts</h3>
      {hosts === null ? (
        <p>Loading…</p>
      ) : hosts.length === 0 ? (
        <p className="hint">No trusted hosts yet.</p>
      ) : (
        <table className="hosts">
          <thead>
            <tr>
              <th scope="col">Host</th>
              <th scope="col">Key</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {hosts.map((h) => (
              <tr key={h.key} data-testid="trusted-host-row">
                <td>{h.key}</td>
                <td>
                  <div>{h.algorithm}</div>
                  <div className="mono small">{h.fingerprintSha256}</div>
                </td>
                <td>
                  {confirmKey === h.key ? (
                    <span className="inline-confirm">
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          void api()
                            .trustedHosts.remove(h.key)
                            .then(() => {
                              setConfirmKey(null);
                              load();
                            });
                        }}
                      >
                        Confirm remove
                      </button>
                      <button type="button" onClick={() => setConfirmKey(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmKey(h.key)}
                      aria-label={`Remove trusted key for ${h.key}`}
                    >
                      Remove…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">
        Removing a host means the next connection asks you to confirm its key again.
      </p>
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}

export function ConfirmDeleteDialog({
  name,
  onConfirm,
  onClose,
}: {
  name: string;
  onConfirm: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog
      title="Delete server?"
      onClose={onClose}
      initialFocusId="delete-cancel"
      testId="delete-dialog"
      role="alertdialog"
    >
      <p>
        Delete <strong>{name}</strong>? Your key and certificate files, downloaded files and trusted
        host keys are not touched.
      </p>
      <div className="dialog-actions">
        <button id="delete-cancel" type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          Delete
        </button>
      </div>
    </Dialog>
  );
}
