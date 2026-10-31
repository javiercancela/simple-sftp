import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isEncryptedPrivateKey, loadCredentials } from '../../src/main/connections/credentials';
import { TransportError } from '../../src/main/connections/errors';
import {
  decodeOpenSshPublicText,
  parseOpenSshCertificate,
} from '../../src/main/connections/openssh-cert';

let dir = '';
const k = (n: string): string => join(dir, n);
const gen = (name: string, type: string, pass = ''): void => {
  execFileSync('ssh-keygen', ['-q', '-t', type, '-N', pass, '-C', 't', '-f', k(name)]);
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof TransportError ? e.code : 'OTHER';
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sftp-cred-unit-'));
  gen('ed', 'ed25519');
  gen('enc', 'ed25519', 'secret-pass');
  gen('ca', 'ed25519');
  execFileSync('ssh-keygen', [
    '-q',
    '-s',
    k('ca'),
    '-I',
    'id1',
    '-n',
    'alice,bob',
    '-V',
    '-1h:+1h',
    k('ed.pub'),
  ]);
  execFileSync('ssh-keygen', [
    '-q',
    '-s',
    k('ca'),
    '-I',
    'h',
    '-h',
    '-n',
    'host.example',
    '-V',
    '+1h',
    k('enc.pub'),
  ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('credential parsing', () => {
  it('detects encrypted OpenSSH keys structurally', () => {
    expect(isEncryptedPrivateKey(readFileSync(k('enc')))).toBe(true);
    expect(isEncryptedPrivateKey(readFileSync(k('ed')))).toBe(false);
  });

  it('parses a user certificate', () => {
    const d = decodeOpenSshPublicText(readFileSync(k('ed-cert.pub'), 'utf8'));
    expect(d?.type).toBe('ssh-ed25519-cert-v01@openssh.com');
    const c = parseOpenSshCertificate(d!.blob);
    expect(c.type).toBe(1);
    expect(c.keyId).toBe('id1');
    expect(c.principals).toEqual(['alice', 'bob']);
    expect(c.validBefore > c.validAfter).toBe(true);
  });

  it('classifies local credential errors', async () => {
    expect(await code(loadCredentials({ privateKeyPath: k('missing') }))).toBe(
      'CREDENTIAL_MISSING',
    );
    expect(await code(loadCredentials({ privateKeyPath: k('ed.pub') }))).toBe(
      'CREDENTIAL_MALFORMED',
    );
    expect(await code(loadCredentials({ privateKeyPath: k('enc') }))).toBe('PASSPHRASE_REQUIRED');
    expect(await code(loadCredentials({ privateKeyPath: k('enc'), passphrase: 'x' }))).toBe(
      'PASSPHRASE_INCORRECT',
    );
    expect(
      await code(loadCredentials({ privateKeyPath: k('enc'), passphrase: 'secret-pass' })),
    ).toBe('OK');
    expect(
      await code(loadCredentials({ privateKeyPath: k('ed'), certificatePath: k('ed.pub') })),
    ).toBe('CERT_NOT_A_CERTIFICATE');
    expect(
      await code(loadCredentials({ privateKeyPath: k('ed'), certificatePath: k('ed-cert.pub') })),
    ).toBe('OK');
    expect(
      await code(
        loadCredentials({
          privateKeyPath: k('enc'),
          certificatePath: k('enc-cert.pub'),
          passphrase: 'secret-pass',
        }),
      ),
    ).toBe('CERT_NOT_USER_CERT');
    expect(
      await code(
        loadCredentials({
          privateKeyPath: k('enc'),
          certificatePath: k('ed-cert.pub'),
          passphrase: 'secret-pass',
        }),
      ),
    ).toBe('CERT_KEY_MISMATCH');
  });

  it('never keeps the passphrase for unencrypted keys', async () => {
    const c = await loadCredentials({ privateKeyPath: k('ed'), passphrase: 'ignored' });
    expect(c.passphrase).toBeUndefined();
  });
});
