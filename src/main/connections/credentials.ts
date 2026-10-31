import { readFile } from 'node:fs/promises';
import { utils, type ParsedKey } from '@electerm/ssh2';
import { TransportError } from './errors';
import {
  CERT_TYPE_USER,
  decodeOpenSshPublicText,
  isCertificateType,
  parseOpenSshCertificate,
  type OpenSshCertificate,
} from './openssh-cert';

/** Key algorithms supported in version 1 (spec section 3). */
const SUPPORTED_KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa']);

export interface CredentialInput {
  privateKeyPath: string;
  /** Present only in certificate mode. */
  certificatePath?: string;
  /** Transient; never persisted. */
  passphrase?: string;
}

/** Parsed, in-memory credentials for one connection attempt. */
export interface LoadedCredentials {
  /** Parsed key, used for local checks (type, public half). */
  privateKey: ParsedKey;
  /**
   * Raw key file bytes and passphrase for this attempt only. @electerm/ssh2
   * only accepts key material as string/Buffer (+ passphrase), not a parsed
   * key, so these are handed to the transport and then dropped.
   */
  keyData: Buffer;
  passphrase: string | undefined;
  certificate?: { blob: Buffer; parsed: OpenSshCertificate };
}

export interface CredentialCheckOptions {
  /** Injected clock (unix seconds) for tests. */
  nowSeconds?: bigint;
}

async function readCredentialFile(path: string, what: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new TransportError('CREDENTIAL_MISSING', `${what} file not found.`, code);
    }
    throw new TransportError('CREDENTIAL_UNREADABLE', `${what} file cannot be read.`, code);
  }
}

/** Structural check: is this private key file passphrase-protected? */
export function isEncryptedPrivateKey(data: Buffer): boolean {
  const text = data.toString('utf8');
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) return true;
  if (/Proc-Type:\s*4,ENCRYPTED/.test(text)) return true;
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(
    text,
  );
  if (m && m[1] !== undefined) {
    const blob = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    const magic = 'openssh-key-v1\0';
    if (blob.subarray(0, magic.length).toString('latin1') !== magic) return false;
    const len = blob.readUInt32BE(magic.length);
    const cipher = blob.subarray(magic.length + 4, magic.length + 4 + len).toString('latin1');
    return cipher !== 'none';
  }
  return false;
}

/** Parse key (and optional certificate) material without validity checks. */
export function parseCredentialMaterial(
  keyData: Buffer,
  certData: Buffer | undefined,
  passphrase: string | undefined,
): LoadedCredentials {
  const encrypted = isEncryptedPrivateKey(keyData);
  if (encrypted && (passphrase === undefined || passphrase === '')) {
    throw new TransportError(
      'PASSPHRASE_REQUIRED',
      'This private key is encrypted. Enter its passphrase.',
    );
  }
  const parsed = utils.parseKey(keyData, encrypted ? passphrase : undefined);
  if (parsed instanceof Error) {
    if (encrypted) {
      throw new TransportError(
        'PASSPHRASE_INCORRECT',
        'The passphrase is incorrect, or the key is damaged.',
      );
    }
    throw new TransportError(
      'CREDENTIAL_MALFORMED',
      'The private key file could not be parsed.',
      parsed.message,
    );
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key === undefined || !key.isPrivateKey() || key.getPrivatePEM() === null) {
    throw new TransportError('CREDENTIAL_MALFORMED', 'The selected file is not a private key.');
  }
  if (!SUPPORTED_KEY_TYPES.has(key.type)) {
    throw new TransportError(
      'CREDENTIAL_UNSUPPORTED',
      `Key type ${key.type} is not supported. Use Ed25519 or RSA.`,
    );
  }

  const base = { privateKey: key, keyData, passphrase: encrypted ? passphrase : undefined };
  if (certData === undefined) return base;

  const decoded = decodeOpenSshPublicText(certData.toString('utf8'));
  if (decoded === null) {
    throw new TransportError(
      'CERT_NOT_A_CERTIFICATE',
      'The certificate file is not an OpenSSH certificate.',
    );
  }
  if (!isCertificateType(decoded.type)) {
    throw new TransportError(
      'CERT_NOT_A_CERTIFICATE',
      'The selected certificate file is a plain public key, not a CA-signed OpenSSH user certificate.',
    );
  }
  let cert: OpenSshCertificate;
  try {
    cert = parseOpenSshCertificate(decoded.blob);
  } catch (err) {
    throw new TransportError(
      'CREDENTIAL_MALFORMED',
      'The certificate file could not be parsed.',
      (err as Error).message,
    );
  }
  return { ...base, certificate: { blob: decoded.blob, parsed: cert } };
}

/** Local checks the client can make before connecting (spec 3.1). */
export function checkCertificateLocally(
  creds: LoadedCredentials,
  opts: CredentialCheckOptions = {},
): void {
  const c = creds.certificate?.parsed;
  if (!c) return;
  if (c.type !== CERT_TYPE_USER) {
    throw new TransportError(
      'CERT_NOT_USER_CERT',
      'The certificate is a host certificate, not a user certificate.',
    );
  }
  if (!c.publicKeyBlob.equals(creds.privateKey.getPublicSSH())) {
    throw new TransportError(
      'CERT_KEY_MISMATCH',
      'The certificate does not belong to the selected private key.',
    );
  }
  const now = opts.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  if (now < c.validAfter) {
    throw new TransportError('CERT_NOT_YET_VALID', 'The certificate is not valid yet.');
  }
  if (now >= c.validBefore) {
    throw new TransportError(
      'CERT_EXPIRED',
      'The certificate has expired. Renew it and reconnect.',
    );
  }
}

/**
 * Read credential files fresh for this attempt (so renewed certificates are
 * picked up), parse them and run local certificate checks.
 */
export async function loadCredentials(
  input: CredentialInput,
  opts: CredentialCheckOptions = {},
): Promise<LoadedCredentials> {
  const keyData = await readCredentialFile(input.privateKeyPath, 'Private key');
  const certData =
    input.certificatePath === undefined
      ? undefined
      : await readCredentialFile(input.certificatePath, 'Certificate');
  const creds = parseCredentialMaterial(keyData, certData, input.passphrase);
  checkCertificateLocally(creds, opts);
  return creds;
}
