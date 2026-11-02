// Release validation end-to-end (spec 12: A3, A5, A13) against real sshd:
//  - A3: after a session with an encrypted key (wrong, then right passphrase)
//    and a download, nothing under the app's data folder contains the
//    passphrase or key material (every file, incl. Chromium storage).
//  - A5: the certificate file is replaced on disk while the app runs; the next
//    connection uses the new certificate (sshd log shows its ID), no restart.
//  - A13: quitting leaves no app process and no SSH connection: the app's
//    process tree is gone and the server's per-connection processes end.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { descendants, signalAll } from '../integration/helpers/fixture-server';
import { hostFingerprint, keygen, pub, signCert } from '../integration/helpers/keys';
import { SshdInstance, findSshd, freePort } from '../integration/helpers/sshd';

const REPO = resolve(__dirname, '..', '..');
const TMP = resolve(__dirname, '..', '.tmp', `e2e-release-${process.pid}-${Date.now()}`);
const SHOTS = join(REPO, 'docs', 'screenshots');
const CONFIG_HOME = join(TMP, 'config');
const USER_DATA = join(CONFIG_HOME, 'SimpleSFTP');
const FILES = join(TMP, 'sftp-root');
const DL = join(TMP, 'downloads');
const K = (n: string): string => join(TMP, 'keys', n);
const LIVE_CERT = join(TMP, 'live', 'id-cert.pub'); // the path the profile points at
const PRINCIPAL = 'sftp-test-principal';
const PASSPHRASE = `pass-${randomUUID()}`;
const WRONG = `wrong-${randomUUID()}`;
const USER = userInfo().username;
const bin = findSshd();
const built = existsSync(join(REPO, '.vite', 'build', 'main.cjs'));
const MiB = 1024 * 1024;

let certServer: SshdInstance;
let keyServer: SshdInstance;
let app: ElectronApplication | null = null;
let page: Page;
const PROFILE_CERT = randomUUID();
const PROFILE_KEY = randomUUID();
const metrics: Record<string, unknown> = {};

const shot = (name: string): Promise<Buffer> => page.screenshot({ path: join(SHOTS, name) });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const serverSessions = (s: SshdInstance): number[] =>
  s.pid ? descendants(s.pid).map((d) => d.pid) : [];
async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

async function launch(): Promise<void> {
  app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [REPO],
    colorScheme: null,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: CONFIG_HOME,
      SFTP_CLIENT_USER_DATA: USER_DATA,
      ELECTRON_ENABLE_LOGGING: '0',
    },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 20_000 });
  // GitHub's arm64 runner has a short work area. A default window clips the
  // toolbar, and Playwright then waits forever for Connect.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.maximize();
  });
  await app.evaluate(({ dialog }, dir) => {
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const opts = args.at(-1) as { defaultPath?: string };
      const name = (opts.defaultPath ?? 'x').split('/').pop()!;
      return { canceled: false, filePath: `${dir}/${name}` };
    }) as typeof dialog.showSaveDialog;
  }, DL);
}

async function waitStatus(text: string): Promise<void> {
  await page
    .getByTestId('connection-status')
    .filter({ hasText: text })
    .waitFor({ timeout: 25_000 });
}
async function select(name: string): Promise<void> {
  await page.getByTestId('profile-item').filter({ hasText: name }).click();
}
async function connectButton(timeout = 15_000): Promise<void> {
  const top = page.getByTestId('topbar');
  const other = top.getByRole('button', { name: /^Connect to / });
  const plain = top.getByRole('button', { name: 'Connect', exact: true });
  const target = (await other.count()) ? other.first() : plain;
  // The arm64 runner's window manager reports the toolbar as not clickable
  // even after maximize. The button is the real control; dispatch the click.
  await target.click({ force: true, timeout });
}

/** Ends the app and waits for its whole process tree to exit. */
async function quitApp(trigger: () => Promise<void>): Promise<{ tree: number[]; ms: number }> {
  const main = app!.process();
  const tree = [main.pid!, ...descendants(main.pid!).map((d) => d.pid)];
  const exited = new Promise<void>((res) => main.once('exit', () => res()));
  const t0 = Date.now();
  await trigger();
  await exited;
  const gone = await waitUntil(() => tree.every((p) => !alive(p)), 5000);
  app = null;
  expect(gone, `still running: ${tree.filter(alive).join(',')}`).toBe(true);
  return { tree, ms: Date.now() - t0 };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe.skipIf(!bin || !built)('Release validation end-to-end (real sshd, xvfb)', () => {
  beforeAll(async () => {
    for (const d of [join(TMP, 'keys'), join(TMP, 'live'), FILES, DL, SHOTS])
      await mkdir(d, { recursive: true });
    await writeFile(join(FILES, 'notes.txt'), 'release validation\n');
    await writeFile(join(FILES, 'big.bin'), randomBytes(256 * MiB));
    keygen(K('host'), 'ed25519');
    keygen(K('ca'), 'ed25519');
    keygen(K('ed'), 'ed25519');
    keygen(K('ed_enc'), 'ed25519', PASSPHRASE);
    const sign = (id: string, validity: string): string =>
      signCert({
        caPath: K('ca'),
        keyPath: K('ed'),
        principals: [PRINCIPAL],
        validity,
        identity: id,
        outName: K(`${id}-cert.pub`),
      });
    // The live certificate starts out expired.
    await copyFile(sign('expired-cert', '-3d:-1d'), LIVE_CERT);
    sign('renewed-1', '-5m:+1h');
    sign('renewed-2', '-5m:+1h');
    const common = { hostKeys: [K('host')], sftpRoot: FILES };
    certServer = new SshdInstance(bin!, {
      ...common,
      dir: join(TMP, 'srv-cert'),
      port: await freePort(),
      trustedUserCa: pub(K('ca')),
      principals: [PRINCIPAL],
    });
    keyServer = new SshdInstance(bin!, {
      ...common,
      dir: join(TMP, 'srv-key'),
      port: await freePort(),
      authorizedKeys: [pub(K('ed_enc'))],
    });
    await certServer.start();
    await keyServer.start();

    await mkdir(USER_DATA, { recursive: true });
    const now = new Date().toISOString();
    const base = {
      createdAt: now,
      updatedAt: now,
      host: '127.0.0.1',
      username: USER,
      initialRemoteDirectory: null,
      downloadDirectory: DL,
    };
    await writeFile(
      join(USER_DATA, 'profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: [
          {
            ...base,
            id: PROFILE_CERT,
            name: 'Renewing cert',
            port: certServer.cfg.port,
            authMode: 'privateKeyAndCertificate',
            privateKeyPath: K('ed'),
            certificatePath: LIVE_CERT,
          },
          {
            ...base,
            id: PROFILE_KEY,
            name: 'Encrypted key',
            port: keyServer.cfg.port,
            authMode: 'privateKey',
            privateKeyPath: K('ed_enc'),
            certificatePath: null,
          },
        ],
      }),
    );
    const fp = hostFingerprint(K('host.pub'));
    const host = (port: number) => ({
      host: '127.0.0.1',
      port,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: fp,
      addedAt: now,
    });
    await writeFile(
      join(USER_DATA, 'trusted-hosts.json'),
      JSON.stringify({
        version: 1,
        hosts: {
          [`127.0.0.1:${certServer.cfg.port}`]: host(certServer.cfg.port),
          [`127.0.0.1:${keyServer.cfg.port}`]: host(keyServer.cfg.port),
        },
      }),
    );
    await launch();
  }, 240_000);

  afterAll(async () => {
    if (Object.keys(metrics).length)
      await writeFile(
        join(REPO, 'docs', 'e2e-release-metrics.json'),
        `${JSON.stringify({ measuredAt: new Date().toISOString(), environment: 'Linux, xvfb, Electron app against sshd on 127.0.0.1', ...metrics }, null, 2)}\n`,
      );
    for (const s of [certServer, keyServer]) if (s) signalAll(serverSessions(s), 'SIGCONT');
    try {
      app?.process().kill('SIGKILL');
    } catch {
      // Already exited, or Playwright dropped the handle after a failed launch.
    }
    await certServer?.stop();
    await keyServer?.stop();
    if (!process.env.KEEP_TEST_TMP) await rm(TMP, { recursive: true, force: true });
  });

  it('A5: a certificate replaced on disk is used on the next connection, without restarting', async () => {
    await select('Renewing cert');
    await connectButton();
    await waitStatus('Connection failed');
    expect(await page.getByTestId('connection-error').getAttribute('data-code')).toBe(
      'CERT_EXPIRED',
    );
    await shot('38-certificate-expired.png');
    // Renew externally (same path), then connect again in the same app session.
    await copyFile(K('renewed-1-cert.pub'), LIVE_CERT);
    certServer.clearLog();
    await connectButton();
    await waitStatus('Connected');
    // sshd's log arrives asynchronously over its stderr pipe.
    await expect.poll(() => certServer.log).toMatch(/Accepted certificate ID "renewed-1"/);
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await waitStatus('Disconnected');
    // A second renewal: no caching of the first one either.
    await copyFile(K('renewed-2-cert.pub'), LIVE_CERT);
    certServer.clearLog();
    await connectButton();
    await waitStatus('Connected');
    // sshd's log arrives asynchronously over its stderr pipe.
    await expect.poll(() => certServer.log).toMatch(/Accepted certificate ID "renewed-2"/);
    expect(certServer.log).not.toMatch(/Accepted certificate ID "renewed-1"/);
    metrics.a5 =
      'expired cert → CERT_EXPIRED; replaced file → sshd "Accepted certificate ID renewed-1"; replaced again → "renewed-2"; same app process';
  });

  it('A3: wrong passphrase is recoverable; no passphrase or key material is written to the data folder', async () => {
    await select('Encrypted key');
    const pass = page.getByTestId('passphrase-dialog');
    // A slow click on the profile can also fire its double-click connect.
    if (!(await pass.isVisible().catch(() => false))) {
      try {
        await connectButton(4_000);
      } catch (e) {
        if (!(await pass.isVisible().catch(() => false))) throw e;
      }
    }
    await pass.waitFor();
    await pass.getByLabel(/Passphrase for ed_enc/).fill(WRONG);
    await pass.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('passphrase-error').waitFor();
    await pass.getByLabel(/Passphrase for ed_enc/).fill(PASSPHRASE);
    await pass.getByRole('button', { name: 'Unlock' }).click();
    await waitStatus('Connected');
    expect(keyServer.log).toMatch(/Accepted publickey/);
    // Use the session: browse and download (journal and settings get written).
    const notes = page.locator('[data-testid="file-row"][data-name="notes.txt"]');
    await notes.scrollIntoViewIfNeeded();
    await notes.click();
    await page.getByTestId('download-button').click();
    const plan = page.getByTestId('plan-dialog');
    const notesJob = page.locator('[data-testid="download-row"][data-name="notes.txt"]');
    await Promise.race([
      plan.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined),
      notesJob.waitFor({ state: 'attached', timeout: 10_000 }).catch(() => undefined),
    ]);
    if (await plan.isVisible().catch(() => false)) {
      const radio = plan.locator('input[type="radio"]').first();
      if (await radio.count()) await radio.check();
      await plan.getByRole('button', { name: 'Download' }).click();
    }
    // The queue can sit outside a short macOS work area; don't require it to be visible.
    await expect
      .poll(async () => notesJob.getAttribute('data-state'), { timeout: 30_000 })
      .toBe('completed');
    expect(await readFile(join(DL, 'notes.txt'), 'utf8')).toBe('release validation\n');
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await waitStatus('Disconnected');
    await quitApp(() => app!.evaluate(({ app: a }) => a.quit()).catch(() => undefined));

    // Every file under the data folder, in every encoding the secret could take.
    const keyBody = (await readFile(K('ed_enc'), 'utf8'))
      .split('\n')
      .filter((l) => l && !l.startsWith('-----'))
      .join('');
    const needles: Array<[string, Buffer]> = [];
    for (const [label, s] of [
      ['passphrase', PASSPHRASE],
      ['wrong passphrase', WRONG],
    ] as const) {
      needles.push([`${label} utf8`, Buffer.from(s, 'utf8')]);
      needles.push([`${label} utf16le`, Buffer.from(s, 'utf16le')]);
      needles.push([`${label} base64`, Buffer.from(Buffer.from(s).toString('base64'))]);
    }
    needles.push(['private key body', Buffer.from(keyBody.slice(0, 40))]);
    needles.push(['PRIVATE KEY header', Buffer.from('PRIVATE KEY')]);
    const files = await walk(CONFIG_HOME);
    let bytes = 0;
    const hits: string[] = [];
    for (const f of files) {
      const data = await readFile(f);
      bytes += data.length;
      for (const [label, n] of needles) if (data.includes(n)) hits.push(`${label} in ${f}`);
    }
    expect(files.length).toBeGreaterThan(5);
    expect(hits).toEqual([]);
    metrics.a3 = `scanned ${files.length} files (${(bytes / 1024).toFixed(0)} KiB) under the data folder incl. Chromium storage for the passphrase (utf8/utf16le/base64), the wrong passphrase and private key material: 0 hits`;
    metrics.a3Files = files.map((f) => f.slice(CONFIG_HOME.length + 1)).sort();
  });

  it('A13: quitting while connected leaves no app process and closes the SSH connection', async () => {
    await launch();
    await select('Renewing cert');
    await connectButton();
    await waitStatus('Connected');
    const sessions = serverSessions(certServer);
    expect(sessions.length).toBeGreaterThan(0);
    // OpenSSH at DEBUG3 is still writing post-auth lines when the UI is already
    // connected. Quitting in that window makes it log a broken pipe instead of
    // the client's disconnect.
    await page.waitForTimeout(400);
    certServer.clearLog();
    const { tree, ms } = await quitApp(() =>
      app!.evaluate(({ app: a }) => a.quit()).catch(() => undefined),
    );
    const closed = await waitUntil(() => serverSessions(certServer).length === 0, 5000);
    expect(closed, `server sessions left: ${serverSessions(certServer).join(',')}`).toBe(true);
    // The client said goodbye (SSH disconnect message), not just a dropped socket.
    const bye = /Received disconnect from 127\.0\.0\.1[^\r\n]*/.exec(certServer.log)?.[0];
    expect(bye).toBeTruthy();
    metrics.a13Idle = `app.quit() while connected: ${tree.length} app processes exited in ${ms} ms; server sessions ended; sshd: "${bye}"`;
  });

  it('A13: quitting with a pending download asks first; cancelling quits with no processes, connection or partial file', async () => {
    await launch();
    await select('Renewing cert');
    await connectButton();
    await waitStatus('Connected');
    const big = page.locator('[data-testid="file-row"][data-name="big.bin"]');
    await big.scrollIntoViewIfNeeded();
    await big.click();
    const download = page.getByTestId('download-button');
    await expect.poll(() => download.innerText()).toMatch(/Download \(1\)/);
    await download.click();
    const plan = page.getByTestId('plan-dialog');
    const row = page.locator('[data-testid="download-row"]');
    const which = await Promise.race([
      plan.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'plan' as const),
      row.waitFor({ state: 'attached', timeout: 20_000 }).then(() => 'row' as const),
    ]);
    if (which === 'plan') {
      const radio = plan.locator('input[type="radio"]').first();
      if (await radio.count()) await radio.check();
      await plan.getByRole('button', { name: 'Download' }).click();
      await row.waitFor({ state: 'attached' });
    }
    // Stop the server before a fast link finishes the 256 MiB file.
    signalAll(serverSessions(certServer), 'SIGSTOP');
    // Quit from the app menu / Cmd+Q path (before-quit), not the window.
    await app!.evaluate(({ app: a }) => a.quit());
    const dlg = page.getByTestId('pending-dialog');
    await dlg.waitFor();
    expect(await dlg.innerText()).toMatch(/1 download is still in progress/);
    await dlg.getByRole('button', { name: 'Keep downloading' }).click();
    await dlg.waitFor({ state: 'detached' });
    expect(app!.process().exitCode).toBeNull();
    await app!.evaluate(({ app: a }) => a.quit());
    await dlg.waitFor();
    const { tree, ms } = await quitApp(() =>
      dlg.getByRole('button', { name: 'Cancel downloads and quit' }).click(),
    );
    signalAll(serverSessions(certServer), 'SIGCONT');
    const closed = await waitUntil(() => serverSessions(certServer).length === 0, 5000);
    expect(closed, `server sessions left: ${serverSessions(certServer).join(',')}`).toBe(true);
    const leftovers = (await readdir(DL)).filter((n) => n.startsWith('big.bin'));
    expect(leftovers).toEqual([]);
    const journal = JSON.parse(await readFile(join(USER_DATA, 'transfer-journal.json'), 'utf8'));
    expect(journal.entries).toEqual([]);
    expect((await stat(join(DL, 'notes.txt'))).size).toBeGreaterThan(0);
    metrics.a13Pending = `quit with a download in flight (server frozen): prompt shown; Keep downloading kept it running; Cancel downloads and quit → ${tree.length} app processes exited in ${ms} ms, server sessions ended, no partial file, journal empty`;
    // No stray Electron processes from this repo anywhere (e.g. helpers reparented to init).
    const stray = execFileSync('ps', ['-e', '-o', 'pid=,args='])
      .toString()
      .split('\n')
      .filter((l) => l.includes(join(REPO, 'node_modules', 'electron', 'dist')));
    expect(stray).toEqual([]);
  });
});
