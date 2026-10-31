import { createHash } from 'node:crypto';
import type { HostKeyInfo } from '../../shared/transport-contract';

/** OpenSSH-style SHA-256 fingerprint of a host key wire blob. */
export function fingerprintSha256(keyBlob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');
}

export function hostKeyAlgorithm(keyBlob: Buffer): string {
  if (keyBlob.length < 4) return 'unknown';
  const len = keyBlob.readUInt32BE(0);
  if (len > keyBlob.length - 4 || len > 256) return 'unknown';
  return keyBlob.subarray(4, 4 + len).toString('latin1');
}

/** Normalize host for trust-store keys: lowercase, strip IPv6 brackets. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
}

export function describeHostKey(host: string, port: number, keyBlob: Buffer): HostKeyInfo {
  return {
    host: normalizeHost(host),
    port,
    algorithm: hostKeyAlgorithm(keyBlob),
    fingerprintSha256: fingerprintSha256(keyBlob),
  };
}

export interface TrustedHostRecord {
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
}

export type TrustEvaluation =
  | { kind: 'trusted' }
  | { kind: 'unknown' }
  | { kind: 'mismatch'; expected: TrustedHostRecord };

/** Pure trust matching; the persistent store is built in milestone 2. */
export function evaluateHostKey(
  stored: TrustedHostRecord | undefined,
  presented: HostKeyInfo,
): TrustEvaluation {
  if (!stored) return { kind: 'unknown' };
  if (
    stored.algorithm === presented.algorithm &&
    stored.fingerprintSha256 === presented.fingerprintSha256
  ) {
    return { kind: 'trusted' };
  }
  return { kind: 'mismatch', expected: stored };
}

export function trustKey(host: string, port: number): string {
  const h = normalizeHost(host);
  return h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`;
}
