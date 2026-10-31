import type { ConnectionError } from '../../shared/connection';

const NEXT: Record<string, string> = {
  HOST_KEY_MISMATCH:
    'Confirm the new fingerprint with the server administrator. To replace the stored key, open Settings → Trusted hosts, remove it, then connect again.',
  AUTH_REJECTED:
    'Check the username, the key, and (for certificates) the principals and CA the server trusts.',
  CERT_EXPIRED: 'Renew the certificate file, then connect again. No restart is needed.',
  CERT_NOT_YET_VALID: 'Check your computer clock or wait until the certificate becomes valid.',
  CERT_KEY_MISMATCH: 'Edit the server and select the certificate that belongs to this private key.',
  CERT_NOT_A_CERTIFICATE:
    'Edit the server and select the CA-signed certificate file (often *-cert.pub).',
  CERT_NOT_USER_CERT: 'Select a user certificate, not a host certificate.',
  CREDENTIAL_MISSING: 'Edit the server and select an existing file.',
  CREDENTIAL_UNREADABLE: 'Check the file permissions, or edit the server and select another file.',
  CREDENTIAL_MALFORMED: 'Edit the server and select a valid OpenSSH or PEM private key.',
  CREDENTIAL_UNSUPPORTED: 'Use an Ed25519 or RSA key.',
  SERVER_REFUSED:
    'Wait a minute, then connect again. Repeated failed logins can make the server block this address for a while.',
  NETWORK: 'Check the host name, port and your network connection.',
  TIMEOUT: 'Check that the server is reachable and the port is right, then try again.',
  CONNECTION_LOST: 'Connect again when the network is available.',
  SFTP_UNAVAILABLE: 'The account may not have SFTP enabled. Contact the server administrator.',
  HOST_KEY_UNSUPPORTED: 'This server only offers a host identity type the app does not support.',
};

export function ErrorPanel({
  error,
  onDismiss,
}: {
  error: ConnectionError;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <section
      className="error-panel"
      role="alert"
      data-testid="connection-error"
      data-code={error.code}
    >
      <div className="error-main">
        <strong>{error.message}</strong>
        {NEXT[error.code] && <p>{NEXT[error.code]}</p>}
        {error.expectedFingerprint && error.receivedFingerprint && (
          <dl className="kv">
            <dt>Expected</dt>
            <dd className="mono" data-testid="expected-fingerprint">
              {error.expectedFingerprint}
            </dd>
            <dt>Received</dt>
            <dd className="mono" data-testid="received-fingerprint">
              {error.receivedFingerprint}
            </dd>
          </dl>
        )}
        <details>
          <summary>Technical details</summary>
          <p className="mono small">
            {error.code}
            {error.detail ? `: ${error.detail}` : ''}
          </p>
        </details>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss error">
        Dismiss
      </button>
    </section>
  );
}
