import { useState } from 'react';
import type { Challenge } from '../../shared/connection';
import { api } from '../api';
import { Dialog } from './Dialog';

export function TrustDialog({
  challenge,
}: {
  challenge: Challenge & { kind: 'hostTrust' };
}): React.JSX.Element {
  const k = challenge.hostKey;
  const reject = (): void => void api().trust.reject(challenge.challengeId);
  return (
    <Dialog
      title="Trust this server?"
      onClose={reject}
      initialFocusId="trust-cancel"
      testId="trust-dialog"
      role="alertdialog"
    >
      <p>
        This is the first connection to this server from this app. Compare the fingerprint with one
        your administrator gave you before trusting it.
      </p>
      <dl className="kv">
        <dt>Host</dt>
        <dd data-testid="trust-host">{k.host}</dd>
        <dt>Port</dt>
        <dd>{k.port}</dd>
        <dt>Key type</dt>
        <dd data-testid="trust-algorithm">{k.algorithm}</dd>
        <dt>SHA-256 fingerprint</dt>
        <dd className="mono" data-testid="trust-fingerprint">
          {k.fingerprintSha256}
        </dd>
      </dl>
      <div className="dialog-actions">
        <button id="trust-cancel" type="button" onClick={reject}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void api().trust.accept(challenge.challengeId)}
        >
          Trust and connect
        </button>
      </div>
    </Dialog>
  );
}

export function PassphraseDialog({
  challenge,
}: {
  challenge: Challenge & { kind: 'passphrase' };
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const cancel = (): void => void api().passphrase.cancel(challenge.challengeId);
  return (
    <Dialog
      title="Unlock private key"
      onClose={cancel}
      initialFocusId="passphrase-input"
      testId="passphrase-dialog"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value) return;
          setBusy(true);
          const v = value;
          setValue('');
          void api().passphrase.submit(challenge.challengeId, v);
        }}
      >
        <div className="field">
          <label htmlFor="passphrase-input">Passphrase for {challenge.keyFileName}</label>
          <input
            id="passphrase-input"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={challenge.retry ? true : undefined}
            aria-describedby={challenge.retry ? 'passphrase-err' : 'passphrase-hint'}
          />
          {challenge.retry ? (
            <p
              id="passphrase-err"
              className="field-error"
              role="alert"
              data-testid="passphrase-error"
            >
              That passphrase is incorrect. Try again.
            </p>
          ) : (
            <p id="passphrase-hint" className="hint">
              Used for this connection only; it is never saved.
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!value || busy}>
            Unlock
          </button>
        </div>
      </form>
    </Dialog>
  );
}
