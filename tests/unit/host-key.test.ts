import { describe, expect, it } from 'vitest';
import {
  describeHostKey,
  evaluateHostKey,
  fingerprintSha256,
  hostKeyAlgorithm,
  normalizeHost,
  trustKey,
} from '../../src/main/connections/host-key';

// ssh-ed25519 wire blob: string "ssh-ed25519" + string(32 bytes)
function edBlob(fill: number): Buffer {
  const t = Buffer.from('ssh-ed25519');
  const k = Buffer.alloc(32, fill);
  const b = Buffer.alloc(4 + t.length + 4 + k.length);
  b.writeUInt32BE(t.length, 0);
  t.copy(b, 4);
  b.writeUInt32BE(k.length, 4 + t.length);
  k.copy(b, 8 + t.length);
  return b;
}

describe('host key helpers', () => {
  it('formats OpenSSH-style SHA-256 fingerprints without padding', () => {
    const fp = fingerprintSha256(edBlob(1));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('reads the algorithm from the wire blob and tolerates junk', () => {
    expect(hostKeyAlgorithm(edBlob(1))).toBe('ssh-ed25519');
    expect(hostKeyAlgorithm(Buffer.from([0, 0]))).toBe('unknown');
    expect(hostKeyAlgorithm(Buffer.from([0xff, 0xff, 0xff, 0xff, 1]))).toBe('unknown');
  });

  it('normalizes hosts and builds trust keys', () => {
    expect(normalizeHost(' Example.COM ')).toBe('example.com');
    expect(normalizeHost('[::1]')).toBe('::1');
    expect(trustKey('Example.com', 22)).toBe('example.com:22');
    expect(trustKey('[::1]', 2222)).toBe('[::1]:2222');
  });

  it('evaluates trust: unknown, trusted, mismatch', () => {
    const a = describeHostKey('h', 22, edBlob(1));
    const b = describeHostKey('h', 22, edBlob(2));
    expect(evaluateHostKey(undefined, a)).toEqual({ kind: 'unknown' });
    expect(evaluateHostKey(a, a)).toEqual({ kind: 'trusted' });
    expect(evaluateHostKey(a, b)).toEqual({ kind: 'mismatch', expected: a });
  });
});
