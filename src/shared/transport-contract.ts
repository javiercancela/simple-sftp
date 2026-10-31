// Pure, serializable contracts shared by main, preload and renderer.
// Must not import Electron or Node APIs (enforced by lint).
import { z } from 'zod';

export const TRANSPORT_ERROR_CODES = [
  'CREDENTIAL_MISSING',
  'CREDENTIAL_UNREADABLE',
  'CREDENTIAL_MALFORMED',
  'CREDENTIAL_UNSUPPORTED',
  'PASSPHRASE_REQUIRED',
  'PASSPHRASE_INCORRECT',
  'CERT_NOT_A_CERTIFICATE',
  'CERT_NOT_USER_CERT',
  'CERT_KEY_MISMATCH',
  'CERT_EXPIRED',
  'CERT_NOT_YET_VALID',
  'HOST_KEY_REJECTED',
  'HOST_KEY_MISMATCH',
  'HOST_KEY_UNSUPPORTED',
  'NETWORK',
  'TIMEOUT',
  'AUTH_REJECTED',
  'SFTP_UNAVAILABLE',
  'CANCELLED',
  'REMOTE_NOT_FOUND',
  'REMOTE_PERMISSION_DENIED',
  'REMOTE_ERROR',
  'DISCONNECTED',
] as const;

export const TransportErrorCodeSchema = z.enum(TRANSPORT_ERROR_CODES);
export type TransportErrorCode = z.infer<typeof TransportErrorCodeSchema>;

/** Host identity presented by a server, shown to the user before trusting. */
export const HostKeyInfoSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  algorithm: z.string().min(1),
  /** OpenSSH style: "SHA256:<unpadded base64>" */
  fingerprintSha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
});
export type HostKeyInfo = z.infer<typeof HostKeyInfoSchema>;

export type RemoteEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface RemoteEntry {
  name: string;
  type: RemoteEntryType;
  /** Bytes; null when the server did not report it. */
  size: number | null;
  /** Unix epoch seconds; null when unknown. */
  modifiedTime: number | null;
}

export interface RemoteStat {
  type: RemoteEntryType;
  size: number | null;
  modifiedTime: number | null;
}

export type AuthMode = 'privateKey' | 'privateKeyAndCertificate';
