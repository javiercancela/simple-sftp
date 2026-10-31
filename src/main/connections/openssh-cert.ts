// Minimal OpenSSH certificate parser (PROTOCOL.certkeys). Used only for local
// pre-connection checks; the server stays authoritative for CA trust,
// principals, critical options and revocation.

export const CERT_TYPE_USER = 1;
export const CERT_TYPE_HOST = 2;

export interface OpenSshCertificate {
  certType: string; // e.g. ssh-ed25519-cert-v01@openssh.com
  /** Wire blob of the certified public key in plain (non-cert) form. */
  publicKeyBlob: Buffer;
  serial: bigint;
  type: number; // 1 = user, 2 = host
  keyId: string;
  principals: string[];
  validAfter: bigint; // unix seconds
  validBefore: bigint; // unix seconds, 2^64-1 = forever
  raw: Buffer;
}

const CERT_SUFFIX = '-cert-v01@openssh.com';

class Reader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}
  private need(n: number): void {
    if (this.off + n > this.buf.length) throw new Error('truncated certificate');
  }
  uint32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }
  uint64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64BE(this.off);
    this.off += 8;
    return v;
  }
  bytes(): Buffer {
    const len = this.uint32();
    this.need(len);
    const v = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return v;
  }
  string(): string {
    return this.bytes().toString('utf8');
  }
  remaining(): number {
    return this.buf.length - this.off;
  }
}

function sshString(b: Buffer | string): Buffer {
  const data = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

/** Decode the text form "<type> <base64> [comment]" into the binary blob. */
export function decodeOpenSshPublicText(text: string): { type: string; blob: Buffer } | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [type, b64] = parts as [string, string];
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) return null;
  const blob = Buffer.from(b64, 'base64');
  if (blob.length < 4) return null;
  try {
    const inner = new Reader(blob).string();
    if (inner !== type) return null;
  } catch {
    return null;
  }
  return { type, blob };
}

export function isCertificateType(type: string): boolean {
  return type.endsWith(CERT_SUFFIX);
}

export function parseOpenSshCertificate(blob: Buffer): OpenSshCertificate {
  const r = new Reader(blob);
  const certType = r.string();
  if (!isCertificateType(certType)) throw new Error('not an OpenSSH certificate');
  r.bytes(); // nonce
  const baseType = certType.slice(0, -CERT_SUFFIX.length);
  let publicKeyBlob: Buffer;
  if (baseType === 'ssh-ed25519') {
    const pk = r.bytes();
    publicKeyBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pk)]);
  } else if (baseType === 'ssh-rsa') {
    const e = r.bytes();
    const n = r.bytes();
    publicKeyBlob = Buffer.concat([sshString('ssh-rsa'), sshString(e), sshString(n)]);
  } else if (baseType.startsWith('ecdsa-sha2-')) {
    const curve = r.bytes();
    const q = r.bytes();
    publicKeyBlob = Buffer.concat([sshString(baseType), sshString(curve), sshString(q)]);
  } else {
    throw new Error(`unsupported certificate key type ${baseType}`);
  }
  const serial = r.uint64();
  const type = r.uint32();
  const keyId = r.string();
  const principalsBlob = r.bytes();
  const validAfter = r.uint64();
  const validBefore = r.uint64();
  const principals: string[] = [];
  const pr = new Reader(principalsBlob);
  while (pr.remaining() > 0) principals.push(pr.string());
  // critical options, extensions, reserved, signature key, signature
  r.bytes();
  r.bytes();
  r.bytes();
  r.bytes();
  r.bytes();
  return {
    certType,
    publicKeyBlob,
    serial,
    type,
    keyId,
    principals,
    validAfter,
    validBefore,
    raw: blob,
  };
}
