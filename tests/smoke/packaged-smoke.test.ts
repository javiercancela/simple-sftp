// Packaged transport smoke test (spec 3.2 step 6 / spec 11).
// Runs the *packaged* app (from the make artifacts) against a real
// certificate-only OpenSSH server on 127.0.0.1 and checks its JSON report.
// Prerequisite: `npm run make` (or `npm run package`).
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostFingerprint, keygen, pub, signCert } from '../integration/helpers/keys';
import { SshdInstance, findSshd, freePort } from '../integration/helpers/sshd';

const ROOT_DIR = resolve(__dirname, '..', '..');
const TMP = resolve(__dirname, '..', '.tmp', `smoke-${process.pid}-${Date.now()}`);
const K = (n: string): string => join(TMP, 'keys', n);
const PRINCIPAL = 'sftp-test-principal';

interface Candidate {
  label: string;
  /** Returns the executable path, extracting the artifact if needed. */
  prepare: () => string;
}

function findFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name.endsWith(suffix)) out.push(join(e.parentPath, e.name));
  }
  return out;
}

function candidates(): Candidate[] {
  if (process.env.SMOKE_APP_PATH) {
    const p = process.env.SMOKE_APP_PATH;
    return [{ label: 'SMOKE_APP_PATH', prepare: () => p }];
  }
  const list: Candidate[] = [];
  const make = join(ROOT_DIR, 'out', 'make');
  if (process.platform === 'linux') {
    for (const zip of findFiles(join(make, 'zip', 'linux'), '.zip')) {
      list.push({
        label: `zip ${zip.split('/').pop()}`,
        prepare: () => {
          const dest = join(TMP, 'extract-zip');
          execFileSync('unzip', ['-q', '-o', zip, '-d', dest]);
          const bin = findFiles(dest, 'simple-sftp')[0];
          if (!bin) throw new Error('simple-sftp not found in zip');
          return bin;
        },
      });
    }
    for (const deb of findFiles(join(make, 'deb'), '.deb')) {
      list.push({
        label: `deb ${deb.split('/').pop()}`,
        prepare: () => {
          const dest = join(TMP, 'extract-deb');
          execFileSync('dpkg-deb', ['-x', deb, dest]);
          const bin = findFiles(join(dest, 'usr', 'lib'), 'simple-sftp')[0];
          if (!bin) throw new Error('simple-sftp not found in deb');
          return bin;
        },
      });
    }
  }
  const pkgDir = join(ROOT_DIR, 'out', `SimpleSFTP-${process.platform}-${process.arch}`);
  const exe =
    process.platform === 'darwin'
      ? join(pkgDir, 'SimpleSFTP.app', 'Contents', 'MacOS', 'SimpleSFTP')
      : process.platform === 'win32'
        ? join(pkgDir, 'simple-sftp.exe')
        : join(pkgDir, 'simple-sftp');
  if (existsSync(exe))
    list.push({ label: `packaged dir ${pkgDir.split(/[\\/]/).pop()}`, prepare: () => exe });
  return list;
}

const bin = findSshd();
const apps = candidates();
let server: SshdInstance;
let expectedSha = '';

function runApp(exe: string, configPath: string): Promise<{ code: number | null; output: string }> {
  const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
  const cmd = useXvfb ? 'xvfb-run' : exe;
  const args = useXvfb ? ['-a', exe] : [];
  return new Promise((res) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SFTP_CLIENT_TRANSPORT_SMOKE: configPath };
    delete env.ELECTRON_RUN_AS_NODE;
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    p.stdout.on('data', (d: Buffer) => (output += d.toString()));
    p.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const t = setTimeout(() => p.kill('SIGKILL'), 90_000);
    p.on('exit', (code) => {
      clearTimeout(t);
      res({ code, output });
    });
  });
}

describe.skipIf(!bin || apps.length === 0)('packaged app transport smoke', () => {
  beforeAll(async () => {
    await mkdir(join(TMP, 'keys'), { recursive: true });
    await mkdir(join(TMP, 'sftp-root'), { recursive: true });
    keygen(K('host_ed25519'), 'ed25519');
    keygen(K('ca'), 'ed25519');
    keygen(K('ed'), 'ed25519');
    keygen(K('rsa'), 'rsa');
    signCert({ caPath: K('ca'), keyPath: K('ed'), principals: [PRINCIPAL], validity: '-5m:+1h' });
    signCert({ caPath: K('ca'), keyPath: K('rsa'), principals: [PRINCIPAL], validity: '-5m:+1h' });
    const data = randomBytes(3 * 1024 * 1024 + 17);
    await writeFile(join(TMP, 'sftp-root', 'payload.bin'), data);
    expectedSha = createHash('sha256').update(data).digest('hex');
    // Ed25519-only host key: RSA certificates must still use SHA-2.
    server = new SshdInstance(bin!, {
      dir: join(TMP, 'server'),
      port: await freePort(),
      hostKeys: [K('host_ed25519')],
      sftpRoot: join(TMP, 'sftp-root'),
      trustedUserCa: pub(K('ca')),
      principals: [PRINCIPAL],
    });
    await server.start();
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
    if (!process.env.KEEP_TEST_TMP) await rm(TMP, { recursive: true, force: true });
  });

  for (const app of apps) {
    it(`${app.label}: certificate login, list and hashed download inside the packaged app`, async () => {
      const exe = app.prepare();
      const outDir = join(TMP, 'out', app.label.replace(/[^a-z0-9]+/gi, '_'));
      await mkdir(outDir, { recursive: true });
      const resultPath = join(outDir, 'result.json');
      const configPath = join(outDir, 'smoke.json');
      await writeFile(
        configPath,
        JSON.stringify({
          host: '127.0.0.1',
          port: server.cfg.port,
          username: userInfo().username,
          expectedHostFingerprint: hostFingerprint(K('host_ed25519.pub')),
          remoteFile: 'payload.bin',
          expectedSha256: expectedSha,
          outputDir: outDir,
          resultPath,
          logins: [
            {
              label: 'ed25519-cert',
              privateKeyPath: K('ed'),
              certificatePath: K('ed-cert.pub'),
              expect: 'success',
            },
            {
              label: 'rsa-cert',
              privateKeyPath: K('rsa'),
              certificatePath: K('rsa-cert.pub'),
              expect: 'success',
            },
            { label: 'plain-key-rejected', privateKeyPath: K('ed'), expect: 'AUTH_REJECTED' },
          ],
        }),
      );
      const { code, output } = await runApp(exe, configPath);
      const result = existsSync(resultPath) ? JSON.parse(await readFile(resultPath, 'utf8')) : null;
      // Printed so CI logs show the evidence.
      console.log(`[smoke] ${app.label} exit=${code}\n${JSON.stringify(result, null, 2)}`);
      if (!result) console.log(output);
      expect(result?.ok, output).toBe(true);
      expect(code).toBe(0);
      expect(String(result.mainScript)).toMatch(/app\.asar/);
    }, 120_000);
  }
});

describe.skipIf(process.env.SFTP_TEST_ALLOW_NO_SSHD === '1')('smoke prerequisites', () => {
  it('found sshd and at least one packaged artifact (run `npm run make` first)', () => {
    expect(bin).toBeDefined();
    expect(apps.length).toBeGreaterThan(0);
  });
});
