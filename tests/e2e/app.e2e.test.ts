// End-to-end: drives the real Electron app (production Vite build in .vite/,
// run with the dev Electron binary) through Playwright against real local
// sshd fixtures. Run via `npm run test:e2e` (packages first, uses xvfb-run on
// Linux). Only the OS file picker is replaced (Playwright cannot click a
// native GTK dialog); everything else is the real app.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostFingerprint, keygen, pub, signCert } from '../integration/helpers/keys';
import { SshdInstance, findSshd, freePort } from '../integration/helpers/sshd';

const REPO = resolve(__dirname, '..', '..');
const TMP = resolve(__dirname, '..', '.tmp', `e2e-${process.pid}-${Date.now()}`);
const SHOTS = join(REPO, 'docs', 'screenshots');
const CONFIG_HOME = join(TMP, 'config'); // XDG_CONFIG_HOME → userData = <this>/SimpleSFTP
const USER_DATA = join(CONFIG_HOME, 'SimpleSFTP');
const K = (n: string): string => join(TMP, 'keys', n);
const PRINCIPAL = 'sftp-test-principal';
const PASSPHRASE = 'correct horse battery staple';
const USER = userInfo().username;

const bin = findSshd();
const built = existsSync(join(REPO, '.vite', 'build', 'main.cjs'));

let certServer: SshdInstance;
let keyServer: SshdInstance;
let app: ElectronApplication | null = null;
let page: Page;

async function launch(): Promise<void> {
  app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [REPO],
    // Let the app's own theme (nativeTheme) drive prefers-color-scheme.
    colorScheme: null,
    env: { ...process.env, XDG_CONFIG_HOME: CONFIG_HOME, ELECTRON_ENABLE_LOGGING: '0' },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 20_000 });
}

async function quit(): Promise<void> {
  if (!app) return;
  await app.close();
  app = null;
}

async function stubFilePicker(path: string): Promise<void> {
  await app!.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [p],
    })) as typeof dialog.showOpenDialog;
  }, path);
}

const status = (): Promise<string> => page.getByTestId('connection-status').innerText();
async function waitStatus(text: string): Promise<void> {
  await page
    .getByTestId('connection-status')
    .filter({ hasText: text })
    .waitFor({ timeout: 25_000 });
}
const shot = (name: string): Promise<Buffer> => page.screenshot({ path: join(SHOTS, name) });

async function addProfile(p: {
  name: string;
  port: number;
  key: string;
  cert?: string;
  certViaPicker?: boolean;
  screenshot?: string;
}): Promise<void> {
  await page.getByRole('button', { name: 'Add server' }).first().click();
  const d = page.getByTestId('profile-dialog');
  await d.getByLabel('Name', { exact: true }).fill(p.name);
  await d.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await d.getByLabel('Port', { exact: true }).fill(String(p.port));
  await d.getByLabel('Username', { exact: true }).fill(USER);
  if (p.cert) await d.getByLabel('Private key + certificate', { exact: true }).check();
  await d.getByLabel('Private key file', { exact: true }).fill(p.key);
  if (p.cert) {
    if (p.certViaPicker) {
      await stubFilePicker(p.cert);
      await d.getByRole('button', { name: 'Browse for certificate file' }).click();
      await expect
        .poll(() => d.getByLabel('Certificate file', { exact: true }).inputValue())
        .toBe(p.cert);
    } else {
      await d.getByLabel('Certificate file', { exact: true }).fill(p.cert);
    }
  }
  if (p.screenshot) await shot(p.screenshot);
  await d.getByRole('button', { name: 'Add server' }).click();
  await d.waitFor({ state: 'detached' });
}

async function selectProfile(name: string): Promise<void> {
  await page.getByTestId('profile-item').filter({ hasText: name }).click();
}

async function connectSelected(): Promise<void> {
  await page.getByTestId('topbar').getByRole('button', { name: 'Connect', exact: true }).click();
}

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(join(USER_DATA, name), 'utf8'));
}

describe.skipIf(!bin || !built)('Electron app end-to-end (real sshd, xvfb)', () => {
  let fpA = '';
  let fpB = '';
  let fpA2 = '';

  beforeAll(async () => {
    await mkdir(join(TMP, 'keys'), { recursive: true });
    await mkdir(join(TMP, 'sftp-root'), { recursive: true });
    await mkdir(SHOTS, { recursive: true });
    await writeFile(join(TMP, 'sftp-root', 'readme.txt'), 'hello\n');
    keygen(K('host_a'), 'ed25519');
    keygen(K('host_a_changed'), 'ed25519');
    keygen(K('host_b'), 'ed25519');
    keygen(K('ca'), 'ed25519');
    keygen(K('ed'), 'ed25519');
    keygen(K('ed_enc'), 'ed25519', PASSPHRASE);
    signCert({ caPath: K('ca'), keyPath: K('ed'), principals: [PRINCIPAL], validity: '-5m:+1h' });
    fpA = hostFingerprint(K('host_a.pub'));
    fpA2 = hostFingerprint(K('host_a_changed.pub'));
    fpB = hostFingerprint(K('host_b.pub'));
    certServer = new SshdInstance(bin!, {
      dir: join(TMP, 'srv-cert'),
      port: await freePort(),
      hostKeys: [K('host_a')],
      sftpRoot: join(TMP, 'sftp-root'),
      trustedUserCa: pub(K('ca')),
      principals: [PRINCIPAL],
    });
    keyServer = new SshdInstance(bin!, {
      dir: join(TMP, 'srv-key'),
      port: await freePort(),
      hostKeys: [K('host_b')],
      sftpRoot: join(TMP, 'sftp-root'),
      authorizedKeys: [pub(K('ed_enc'))],
    });
    await certServer.start();
    await keyServer.start();
  }, 120_000);

  afterAll(async () => {
    await quit().catch(() => undefined);
    await certServer?.stop();
    await keyServer?.stop();
    if (!process.env.KEEP_TEST_TMP) await rm(TMP, { recursive: true, force: true });
  });

  it('starts empty, creates two profiles (one via the file picker IPC) and persists them', async () => {
    await launch();
    await page.getByTestId('empty-state').waitFor();
    await shot('01-empty-state.png');
    await addProfile({
      name: 'Cert server',
      port: certServer.cfg.port,
      key: K('ed'),
      cert: K('ed-cert.pub'),
      certViaPicker: true,
      screenshot: '02-profile-dialog.png',
    });
    await addProfile({ name: 'Encrypted key server', port: keyServer.cfg.port, key: K('ed_enc') });
    await expect.poll(() => page.getByTestId('profile-item').count()).toBe(2);

    // Validation errors are shown, nothing is saved.
    await page.getByRole('button', { name: 'Add server' }).first().click();
    const d = page.getByTestId('profile-dialog');
    await d.getByLabel('Host', { exact: true }).fill('sftp://bad host');
    await d.getByLabel('Port', { exact: true }).fill('70000');
    await d.getByRole('button', { name: 'Add server' }).click();
    await expect.poll(() => d.locator('.field-error').count()).toBeGreaterThanOrEqual(4);
    await d.getByRole('button', { name: 'Cancel' }).click();
    await d.waitFor({ state: 'detached' });

    const file = await readJson('profiles.json');
    expect(file.version).toBe(1);
    expect(file.profiles.map((p: { name: string }) => p.name)).toEqual([
      'Cert server',
      'Encrypted key server',
    ]);
    expect(file.profiles[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(file.profiles[0].certificatePath).toBe(K('ed-cert.pub'));
    expect(JSON.stringify(file)).not.toContain(PASSPHRASE);
  });

  it('preserves geometry, sidebar width, theme and last selection across a restart', async () => {
    await selectProfile('Encrypted key server');
    const sep = page.getByRole('separator', { name: 'Resize sidebar' });
    await sep.focus();
    for (let i = 0; i < 3; i++) await sep.press('ArrowRight');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Theme', { exact: true }).selectOption('dark');
    await page.getByRole('button', { name: 'Done' }).click();
    await app!.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 60, y: 40, width: 1180, height: 760 });
    });
    await page.waitForTimeout(300);
    const ids = (await readJson('profiles.json')).profiles.map((p: { id: string }) => p.id);
    await quit();

    const settings = await readJson('settings.json');
    expect(settings).toMatchObject({
      theme: 'dark',
      sidebarWidth: 290,
      lastSelectedProfileId: ids[1],
    });
    expect(settings.window).toMatchObject({ width: 1180, height: 760 });

    await launch();
    await expect.poll(() => page.getByTestId('profile-item').count()).toBe(2);
    const bounds = await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getBounds(),
    );
    expect(bounds).toMatchObject({ width: 1180, height: 760 });
    expect(await app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(
      true,
    );
    expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([
      1180,
      expect.any(Number),
    ]);
    expect(await page.getByRole('option', { selected: true }).innerText()).toContain(
      'Encrypted key server',
    );
    expect(
      await page.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow'),
    ).toBe('290');
    expect(await status()).toBe('Disconnected'); // launches disconnected
    await shot('03-profile-list-dark.png');
    // Back to light for the remaining screenshots.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Theme', { exact: true }).selectOption('light');
    await page.getByRole('button', { name: 'Done' }).click();
    await shot('04-profile-list.png');
  });

  it('host trust: cancel sends no user auth, accept persists trust and connects', async () => {
    await selectProfile('Cert server');
    certServer.clearLog();
    await connectSelected();
    const trust = page.getByTestId('trust-dialog');
    await trust.waitFor();
    expect(await trust.getByTestId('trust-fingerprint').innerText()).toBe(fpA);
    expect(await trust.getByTestId('trust-algorithm').innerText()).toBe('ssh-ed25519');
    await shot('05-trust-dialog.png');
    await trust.getByRole('button', { name: 'Cancel' }).click();
    await waitStatus('Disconnected');
    await page.waitForTimeout(500);
    expect(certServer.log).toMatch(/Connection from 127\.0\.0\.1/);
    expect(certServer.log).not.toMatch(/userauth-request/);
    expect(existsSync(join(USER_DATA, 'trusted-hosts.json'))).toBe(false);

    await connectSelected();
    await trust.waitFor();
    await trust.getByRole('button', { name: 'Trust and connect' }).click();
    await waitStatus('Connected');
    expect(await page.getByTestId('remote-home').innerText()).toBe(join(TMP, 'sftp-root'));
    expect(certServer.log).toMatch(/Accepted certificate ID/);
    await shot('06-connected.png');
    const hosts = (await readJson('trusted-hosts.json')).hosts;
    expect(hosts[`127.0.0.1:${certServer.cfg.port}`]).toMatchObject({
      fingerprintSha256: fpA,
      algorithm: 'ssh-ed25519',
    });

    await page.getByRole('button', { name: 'Disconnect' }).click();
    await waitStatus('Disconnected');
    // Second connection: already trusted, no dialog.
    await connectSelected();
    await waitStatus('Connected');
    expect(await page.getByTestId('trust-dialog').count()).toBe(0);
  });

  it('switching profiles closes the previous connection; wrong passphrase is recoverable', async () => {
    await selectProfile('Encrypted key server');
    await page.getByRole('button', { name: 'Connect to Encrypted key server' }).click();
    const pass = page.getByTestId('passphrase-dialog');
    await pass.waitFor();
    expect(await status()).toBe('Waiting for passphrase');
    await pass.getByLabel(/Passphrase for ed_enc/).fill('wrong passphrase');
    await pass.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('passphrase-error').waitFor();
    await shot('07-passphrase-retry.png');
    await page
      .getByTestId('passphrase-dialog')
      .getByLabel(/Passphrase for ed_enc/)
      .fill(PASSPHRASE);
    await page.getByTestId('passphrase-dialog').getByRole('button', { name: 'Unlock' }).click();
    const trust = page.getByTestId('trust-dialog');
    await trust.waitFor();
    expect(await trust.getByTestId('trust-fingerprint').innerText()).toBe(fpB);
    await trust.getByRole('button', { name: 'Trust and connect' }).click();
    await waitStatus('Connected');
    expect(await page.getByTestId('active-server').innerText()).toBe('Encrypted key server');
    expect(keyServer.log).toMatch(/Accepted publickey/);
    // Passphrase never persisted.
    for (const f of await readdir(USER_DATA)) {
      if (f.endsWith('.json'))
        expect(await readFile(join(USER_DATA, f), 'utf8')).not.toContain(PASSPHRASE);
    }
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await waitStatus('Disconnected');

    // Cancel at the passphrase prompt goes back to Disconnected.
    await connectSelected();
    await pass.waitFor();
    await pass.getByRole('button', { name: 'Cancel' }).click();
    await waitStatus('Disconnected');
  });

  it('a changed host key is blocked; removing trust in Settings allows re-trusting', async () => {
    await certServer.stop();
    certServer = new SshdInstance(bin!, {
      ...certServer.cfg,
      hostKeys: [K('host_a_changed')],
      dir: join(TMP, 'srv-cert2'),
    });
    await certServer.start();
    await selectProfile('Cert server');
    await connectSelected();
    await waitStatus('Connection failed');
    const err = page.getByTestId('connection-error');
    expect(await err.getAttribute('data-code')).toBe('HOST_KEY_MISMATCH');
    expect(await err.getByTestId('expected-fingerprint').innerText()).toBe(fpA);
    expect(await err.getByTestId('received-fingerprint').innerText()).toBe(fpA2);
    await shot('08-host-key-changed.png');
    await page.waitForTimeout(300);
    expect(certServer.log).not.toMatch(/userauth-request/);
    // Trust store untouched.
    expect(
      (await readJson('trusted-hosts.json')).hosts[`127.0.0.1:${certServer.cfg.port}`]
        .fingerprintSha256,
    ).toBe(fpA);

    await page.getByRole('button', { name: 'Settings' }).click();
    const sd = page.getByTestId('settings-dialog');
    await sd
      .getByRole('button', { name: `Remove trusted key for 127.0.0.1:${certServer.cfg.port}` })
      .click();
    await shot('09-trusted-hosts.png');
    await sd.getByRole('button', { name: 'Confirm remove' }).click();
    await expect.poll(() => sd.getByTestId('trusted-host-row').count()).toBe(1);
    await sd.getByRole('button', { name: 'Done' }).click();

    await connectSelected();
    const trust = page.getByTestId('trust-dialog');
    await trust.waitFor();
    expect(await trust.getByTestId('trust-fingerprint').innerText()).toBe(fpA2);
    await trust.getByRole('button', { name: 'Trust and connect' }).click();
    await waitStatus('Connected');
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await waitStatus('Disconnected');
  });

  it('duplicate, edit and delete persist; deleting keeps credential files and trust', async () => {
    await selectProfile('Cert server');
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect.poll(() => page.getByTestId('profile-item').count()).toBe(3);
    await selectProfile('Cert server (copy)');
    await page.getByRole('button', { name: 'Edit' }).click();
    const d = page.getByTestId('profile-dialog');
    await d.getByLabel('Name', { exact: true }).fill('Renamed copy');
    await d.getByRole('button', { name: 'Save' }).click();
    await d.waitFor({ state: 'detached' });
    await selectProfile('Renamed copy');
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByTestId('delete-dialog').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => page.getByTestId('profile-item').count()).toBe(2);
    const names = (await readJson('profiles.json')).profiles.map((p: { name: string }) => p.name);
    expect(names).toEqual(['Cert server', 'Encrypted key server']);
    expect(existsSync(K('ed'))).toBe(true);
    expect(existsSync(K('ed-cert.pub'))).toBe(true);
    expect(Object.keys((await readJson('trusted-hosts.json')).hosts)).toHaveLength(2);
  });

  it('a corrupt profiles file is preserved and the app offers a clean start', async () => {
    await quit();
    const original = '{"version":1,"profiles":[{"broken": tru';
    await writeFile(join(USER_DATA, 'profiles.json'), original);
    await launch();
    const n = page.getByTestId('recovery-notice');
    await n.waitFor();
    await shot('10-recovered-config.png');
    const backups = (await readdir(USER_DATA)).filter((f) =>
      f.startsWith('profiles.json.corrupt-'),
    );
    expect(backups).toHaveLength(1);
    expect(await readFile(join(USER_DATA, backups[0]!), 'utf8')).toBe(original);
    await page.getByTestId('empty-state').waitFor();
    // Trust store was valid and is still there (no host verification bypass).
    expect(Object.keys((await readJson('trusted-hosts.json')).hosts)).toHaveLength(2);
    await quit();
    // Screenshot hashes so a reviewer can tell files apart.
    const listed = await readdir(SHOTS);
    for (const f of listed) createHash('sha256').update(await readFile(join(SHOTS, f)));
  });
});

describe.skipIf(process.env.SFTP_TEST_ALLOW_NO_SSHD === '1')('e2e prerequisites', () => {
  it('sshd found and the app is built (npm run test:e2e builds it)', () => {
    expect(bin).toBeDefined();
    expect(built).toBe(true);
  });
});
