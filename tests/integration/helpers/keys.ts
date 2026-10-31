// Throwaway SSH test credentials generated with ssh-keygen at test time.
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function keygen(path: string, type: 'ed25519' | 'rsa', passphrase = ''): string {
  const args = ['-q', '-t', type, '-N', passphrase, '-C', 'sftp-client-test', '-f', path];
  if (type === 'rsa') args.push('-b', '3072');
  execFileSync('ssh-keygen', args);
  return path;
}

export function pub(path: string): string {
  return readFileSync(path + '.pub', 'utf8').trim();
}

/**
 * Sign keyPath.pub with caPath. validity like "+1h" or "20200101:20200102".
 * Returns the certificate path (<key>-cert.pub, then renamed if outName given).
 */
export function signCert(opts: {
  caPath: string;
  keyPath: string;
  principals: string[];
  validity: string;
  identity?: string;
  host?: boolean;
  outName?: string;
}): string {
  const args = [
    '-q',
    '-s',
    opts.caPath,
    '-I',
    opts.identity ?? 'sftp-client-test',
    '-n',
    opts.principals.join(','),
    '-V',
    opts.validity,
  ];
  if (opts.host) args.push('-h');
  // Sign a copy of the public key so several certificates for one key can
  // coexist: ssh-keygen always writes <pub without .pub>-cert.pub.
  let pubPath = opts.keyPath + '.pub';
  if (opts.outName) {
    if (!opts.outName.endsWith('-cert.pub')) throw new Error('outName must end with -cert.pub');
    pubPath = opts.outName.slice(0, -'-cert.pub'.length) + '.pub';
    copyFileSync(opts.keyPath + '.pub', pubPath);
  }
  args.push(pubPath);
  execFileSync('ssh-keygen', args);
  return pubPath.slice(0, -'.pub'.length) + '-cert.pub';
}

export function hostFingerprint(pubPath: string): string {
  // "256 SHA256:xxx comment (ED25519)"
  const out = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', pubPath]).toString();
  const fp = out.split(/\s+/)[1];
  if (!fp) throw new Error('could not read fingerprint');
  return fp;
}

export function joinAll(dir: string, ...parts: string[]): string {
  return join(dir, ...parts);
}
