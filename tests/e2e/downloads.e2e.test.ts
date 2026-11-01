// Downloads end-to-end (spec 7, acceptance A8–A13): the real Electron app
// (production bundle, dev Electron binary) against a real local sshd.
// Native Save/folder dialogs can't be driven under xvfb, so they are replaced
// in the main process with stubs that return a chosen path; everything else
// (SFTP, local files, IPC, UI) is real. Faults are real: the server's
// per-connection processes are frozen (SIGSTOP) or killed (SIGKILL), and the
// app itself is SIGKILLed to leave a real orphan partial file.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostFingerprint, keygen, pub, signCert } from '../integration/helpers/keys';
import { SshdInstance, findSshd, freePort } from '../integration/helpers/sshd';

const REPO = resolve(__dirname, '..', '..');
const TMP = resolve(__dirname, '..', '.tmp', `e2e-dl-${process.pid}-${Date.now()}`);
const SHOTS = join(REPO, 'docs', 'screenshots');
const CONFIG_HOME = join(TMP, 'config');
const USER_DATA = join(CONFIG_HOME, 'SimpleSFTP');
const FILES = join(TMP, 'sftp-root');
const DL = join(TMP, 'downloads');
const K = (n: string): string => join(TMP, 'keys', n);
const PRINCIPAL = 'sftp-test-principal';
const USER = userInfo().username;
const bin = findSshd();
const built = existsSync(join(REPO, '.vite', 'build', 'main.cjs'));
const MiB = 1024 * 1024;
const BIG = 192 * MiB;

let server: SshdInstance;
let app: ElectronApplication | null = null;
let page: Page;
let ROOT = '';
const PROFILE_A = randomUUID();
const PROFILE_B = randomUUID();
const metrics: Record<string, unknown> = {};

const shot = (name: string): Promise<Buffer> => page.screenshot({ path: join(SHOTS, name) });
const cssString = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
const fileRow = (name: string) =>
  page.locator(`[data-testid="file-row"][data-name="${cssString(name)}"]`);
const job = (name: string) =>
  page.locator(`[data-testid="download-row"][data-name="${cssString(name)}"]`);
const jobState = (name: string): Promise<string | null> =>
  job(name).last().getAttribute('data-state');
async function waitJob(name: string, state: string, timeout = 60_000): Promise<void> {
  await page
    .locator(`[data-testid="download-row"][data-name="${cssString(name)}"][data-state="${state}"]`)
    .first()
    .waitFor({ timeout });
}
async function waitStatus(text: string): Promise<void> {
  await page
    .getByTestId('connection-status')
    .filter({ hasText: text })
    .waitFor({ timeout: 25_000 });
}
async function waitLocation(path: string): Promise<void> {
  await page.waitForFunction(
    (p) => {
      const b = document.querySelector('[data-testid="browser"]');
      return b?.getAttribute('data-view-path') === p && b.getAttribute('data-busy') === 'false';
    },
    path,
    { timeout: 15_000 },
  );
}
async function sha256(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}
async function partFiles(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.part'));
}

function sessionPids(): number[] {
  const rows = execFileSync('ps', ['-e', '-o', 'pid=,ppid='])
    .toString()
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const out: number[] = [];
  const walk = (p: number): void => {
    for (const [c, pp] of rows) {
      if (pp !== p) continue;
      out.push(c);
      walk(c);
    }
  };
  walk(server.pid!);
  return out;
}
const signalAll = (pids: number[], sig: NodeJS.Signals): void => {
  for (const p of pids) {
    try {
      process.kill(p, sig);
    } catch {
      // already gone
    }
  }
};

interface DialogLog {
  save: string[];
  folder: string[];
  revealed: string[];
}
/** Point the next native Save dialog / folder picker at a path (null = cancel). */
async function nextDialog(kind: 'save' | 'folder', path: string | null): Promise<void> {
  await app!.evaluate(
    (_e, a) => {
      const g = globalThis as unknown as {
        nextSave?: string | null | undefined;
        nextFolder?: string | null;
      };
      if (a.kind === 'save') g.nextSave = a.path;
      else g.nextFolder = a.path;
    },
    { kind, path },
  );
}
const dialogLog = (): Promise<DialogLog> =>
  app!.evaluate(() => (globalThis as unknown as { dialogLog: DialogLog }).dialogLog);

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
  await app.evaluate(({ dialog, shell }) => {
    const g = globalThis as unknown as {
      dialogLog: DialogLog;
      nextSave?: string | null | undefined;
      nextFolder?: string | null | undefined;
    };
    g.dialogLog = { save: [], folder: [], revealed: [] };
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const opts = args.at(-1) as { defaultPath?: string };
      g.dialogLog.save.push(opts.defaultPath ?? '');
      const chosen = g.nextSave === undefined ? opts.defaultPath : g.nextSave;
      g.nextSave = undefined;
      return chosen ? { canceled: false, filePath: chosen } : { canceled: true, filePath: '' };
    }) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const opts = args.at(-1) as { defaultPath?: string };
      g.dialogLog.folder.push(opts.defaultPath ?? '');
      const chosen = g.nextFolder;
      g.nextFolder = undefined;
      return chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] };
    }) as typeof dialog.showOpenDialog;
    shell.showItemInFolder = (p: string) => {
      g.dialogLog.revealed.push(p);
    };
  });
}

async function connect(profileName: string): Promise<void> {
  await page.getByTestId('profile-item').filter({ hasText: profileName }).click();
  await page.getByTestId('topbar').getByRole('button', { name: 'Connect', exact: true }).click();
  await waitStatus('Connected');
  await waitLocation(ROOT);
}

/** Select rows (click, then Ctrl+click) and press Download. */
async function downloadSelected(names: string[]): Promise<void> {
  await fileRow(names[0]!).click();
  for (const n of names.slice(1))
    await fileRow(n).click({
      modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
    });
  await page.getByTestId('download-button').click();
}

describe.skipIf(!bin || !built)('Downloads end-to-end (real sshd, xvfb)', () => {
  beforeAll(async () => {
    await mkdir(join(TMP, 'keys'), { recursive: true });
    await mkdir(SHOTS, { recursive: true });
    await mkdir(FILES, { recursive: true });
    await mkdir(DL, { recursive: true });
    await writeFile(join(FILES, 'zero.bin'), '');
    await writeFile(join(FILES, 'notes.txt'), 'hello from the server\n');
    await writeFile(join(FILES, 'photo.jpg'), randomBytes(3 * MiB + 17));
    await writeFile(join(FILES, 'line\nbreak.txt'), 'control characters in the name\n');
    await mkdir(join(FILES, 'a folder'));
    for (const n of ['q1', 'q2', 'q3', 'q4', 'lost1', 'lost2', 'pending'])
      await writeFile(join(FILES, `${n}.bin`), randomBytes(BIG));
    ROOT = realpathSync(FILES);

    keygen(K('host'), 'ed25519');
    keygen(K('ca'), 'ed25519');
    keygen(K('ed'), 'ed25519');
    signCert({ caPath: K('ca'), keyPath: K('ed'), principals: [PRINCIPAL], validity: '-5m:+2h' });
    server = new SshdInstance(bin!, {
      dir: join(TMP, 'server'),
      port: await freePort(),
      hostKeys: [K('host')],
      sftpRoot: FILES,
      trustedUserCa: pub(K('ca')),
      principals: [PRINCIPAL],
    });
    await server.start();

    await mkdir(USER_DATA, { recursive: true });
    const now = new Date().toISOString();
    const base = {
      createdAt: now,
      updatedAt: now,
      host: '127.0.0.1',
      port: server.cfg.port,
      username: USER,
      authMode: 'privateKeyAndCertificate',
      privateKeyPath: K('ed'),
      certificatePath: K('ed-cert.pub'),
      initialRemoteDirectory: null,
    };
    await writeFile(
      join(USER_DATA, 'profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: [
          { ...base, id: PROFILE_A, name: 'Fixture server', downloadDirectory: DL },
          { ...base, id: PROFILE_B, name: 'Second server', downloadDirectory: null },
        ],
      }),
    );
    await writeFile(
      join(USER_DATA, 'trusted-hosts.json'),
      JSON.stringify({
        version: 1,
        hosts: {
          [`127.0.0.1:${server.cfg.port}`]: {
            host: '127.0.0.1',
            port: server.cfg.port,
            algorithm: 'ssh-ed25519',
            fingerprintSha256: hostFingerprint(K('host.pub')),
            addedAt: now,
          },
        },
      }),
    );
    await writeFile(
      join(USER_DATA, 'settings.json'),
      JSON.stringify({
        version: 1,
        theme: 'light',
        sidebarWidth: 240,
        lastSelectedProfileId: PROFILE_A,
        window: { width: 1280, height: 860, maximized: false },
      }),
    );
    await launch();
  }, 240_000);

  afterAll(async () => {
    if (Object.keys(metrics).length)
      await writeFile(
        join(REPO, 'docs', 'e2e-download-metrics.json'),
        `${JSON.stringify({ measuredAt: new Date().toISOString(), environment: 'Linux, xvfb, Electron app against sshd on 127.0.0.1', ...metrics }, null, 2)}\n`,
      );
    if (server) signalAll(sessionPids(), 'SIGCONT');
    // Pending downloads would make a normal close ask first: end the test app directly.
    app?.process().kill('SIGKILL');
    await server?.stop();
    if (!process.env.KEEP_TEST_TMP) await rm(TMP, { recursive: true, force: true });
  });

  it('release menu: no reload or DevTools; Ctrl+R refreshes the folder without reloading', async () => {
    const menuText = await app!.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      if (!menu) return null;
      const parts: string[] = [];
      const walk = (items: Electron.MenuItem[]): void => {
        for (const item of items) {
          parts.push(`${item.role ?? ''} ${item.label}`.toLowerCase());
          if (item.submenu) walk(item.submenu.items);
        }
      };
      walk(menu.items);
      return parts.join('\n');
    });
    // Windows and Linux have no menu bar. macOS keeps app/Edit/Window, without
    // reload or DevTools (those would bypass the renderer's folder refresh).
    if (process.platform === 'darwin') {
      expect(menuText).toBeTruthy();
      expect(menuText).not.toMatch(/reload|devtools/);
    } else {
      expect(menuText).toBeNull();
    }
    await connect('Fixture server');
    // Queue panel is collapsed while empty.
    expect(await page.getByTestId('download-queue').getAttribute('class')).toBe('queue');
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 42));
    await writeFile(join(FILES, 'appeared.txt'), 'new');
    await fileRow('notes.txt').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+r' : 'Control+r');
    await fileRow('appeared.txt').waitFor({ timeout: 10_000 });
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(42);
    await rm(join(FILES, 'appeared.txt'));
    await page.keyboard.press('F5');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="file-row"][data-name="appeared.txt"]'),
    );
  });

  it('A8: zero-byte and ordinary files via the folder picker; hashes match; Show in folder', async () => {
    await nextDialog('folder', DL);
    await downloadSelected(['zero.bin', 'notes.txt', 'photo.jpg', 'a folder']);
    for (const n of ['zero.bin', 'notes.txt', 'photo.jpg']) await waitJob(n, 'completed');
    // The folder was skipped with a reason; the picker started at the profile folder.
    expect(await page.getByTestId('browser-message').innerText()).toMatch(/not a regular file/);
    expect((await dialogLog()).folder).toEqual([DL]);
    for (const n of ['zero.bin', 'notes.txt', 'photo.jpg'])
      expect(await sha256(join(DL, n)), n).toBe(await sha256(join(FILES, n)));
    expect((await stat(join(DL, 'zero.bin'))).size).toBe(0);
    expect(await partFiles(DL)).toEqual([]);
    await job('photo.jpg').getByRole('button', { name: 'Show in folder' }).click();
    await expect.poll(async () => (await dialogLog()).revealed).toEqual([join(DL, 'photo.jpg')]);
    await shot('30-download-completed.png');
  });

  it('A10: single file uses the Save dialog at the profile folder; collision asks; Keep both', async () => {
    await fileRow('notes.txt').dblclick();
    await page.getByTestId('plan-dialog').waitFor();
    expect((await dialogLog()).save.at(-1)).toBe(join(DL, 'notes.txt'));
    expect(await page.getByTestId('plan-dialog').innerText()).toMatch(/already exists/);
    await shot('31-collision-dialog.png');
    // Nothing is replaced silently: the existing file is untouched until a choice is made.
    await page.getByTestId('plan-dialog').getByRole('radio', { name: 'Keep both' }).check();
    await page.getByTestId('plan-dialog').getByRole('button', { name: 'Download' }).click();
    // The row shows the name the file was finally saved under.
    await waitJob('notes (1).txt', 'completed');
    expect(await readFile(join(DL, 'notes (1).txt'), 'utf8')).toBe('hello from the server\n');
    // Replace, then Skip.
    await writeFile(join(DL, 'notes.txt'), 'LOCAL EDIT');
    await fileRow('notes.txt').dblclick();
    await page.getByTestId('plan-dialog').getByRole('radio', { name: 'Skip' }).check();
    await page.getByTestId('plan-dialog').getByRole('button', { name: 'Download' }).click();
    await page.getByTestId('plan-dialog').waitFor({ state: 'detached' });
    expect(await readFile(join(DL, 'notes.txt'), 'utf8')).toBe('LOCAL EDIT');
    await fileRow('notes.txt').dblclick();
    await page.getByTestId('plan-dialog').getByRole('radio', { name: 'Replace' }).check();
    await page.getByTestId('plan-dialog').getByRole('button', { name: 'Download' }).click();
    await expect
      .poll(() => readFile(join(DL, 'notes.txt'), 'utf8'))
      .toBe('hello from the server\n');
    await page.getByRole('button', { name: 'Clear finished' }).click();
    await page.getByTestId('download-row').first().waitFor({ state: 'detached' });
  });

  it('A12: a remote name that is not a valid local name is offered a rename', async () => {
    const dest = join(TMP, 'names');
    await mkdir(dest);
    await nextDialog('folder', dest);
    await downloadSelected(['line\nbreak.txt', 'zero.bin']);
    const dlg = page.getByTestId('plan-dialog');
    await dlg.waitFor();
    expect(await dlg.getByTestId('plan-item').getAttribute('data-issue')).toBe('invalidName');
    const input = dlg.getByRole('textbox', { name: /New local name/ });
    expect(await input.inputValue()).toBe('line_break.txt');
    await input.fill('../escape.txt');
    await dlg.getByRole('button', { name: 'Download' }).click();
    expect(await dlg.getByRole('alert').innerText()).toMatch(/can’t be used/);
    await input.fill('renamed.txt');
    await shot('34-rename-dialog.png');
    await dlg.getByRole('button', { name: 'Download' }).click();
    await waitJob('renamed.txt', 'completed');
    await waitJob('zero.bin', 'completed');
    expect((await readdir(dest)).sort()).toEqual(['renamed.txt', 'zero.bin']);
    expect(existsSync(join(TMP, 'escape.txt'))).toBe(false);
    await page.getByRole('button', { name: 'Clear finished' }).click();
  });

  it('A9: one transfer at a time; cancel active and queued; retry from zero; memory stays bounded', async () => {
    const dest = join(TMP, 'queue');
    await mkdir(dest);
    const rssSamples: number[] = [];
    const sampler = setInterval(() => {
      void app!
        .evaluate(() => process.memoryUsage().rss)
        .then((r) => rssSamples.push(r))
        .catch(() => undefined);
    }, 150);
    try {
      await nextDialog('folder', dest);
      await downloadSelected(['q1.bin', 'q2.bin', 'q3.bin', 'q4.bin']);
      // Freeze the server once q1 has made progress: the queue stays visibly in flight.
      await page.waitForFunction(() => {
        const r = document.querySelector(
          '[data-testid="download-row"][data-name="q1.bin"][data-state="downloading"]',
        );
        return Number(r?.getAttribute('data-bytes') ?? 0) > 0;
      });
      signalAll(sessionPids(), 'SIGSTOP');
      await page.waitForTimeout(600); // let the last progress event render
      const states = await page
        .getByTestId('download-row')
        .evaluateAll((rs) => rs.map((r) => r.getAttribute('data-state')));
      expect(states.filter((s) => s === 'downloading')).toHaveLength(1);
      expect(states.filter((s) => s === 'queued')).toHaveLength(3);
      await shot('32-queue-in-progress.png');
      // Cancel a queued job and the (frozen) active job.
      await job('q3.bin').getByRole('button', { name: 'Cancel' }).click();
      await waitJob('q3.bin', 'cancelled');
      const t0 = Date.now();
      await job('q1.bin').getByRole('button', { name: 'Cancel' }).click();
      await waitJob('q1.bin', 'cancelled', 10_000);
      metrics.cancelFrozenActiveMs = Date.now() - t0;
      signalAll(sessionPids(), 'SIGCONT');
      await waitJob('q2.bin', 'completed', 120_000);
      await waitJob('q4.bin', 'completed', 120_000);
      // Terminal states don't change: q3 stayed cancelled.
      expect(await jobState('q3.bin')).toBe('cancelled');
      // Retry starts from zero and completes.
      const t1 = Date.now();
      await job('q1.bin').getByRole('button', { name: 'Retry' }).click();
      await waitJob('q1.bin', 'completed', 120_000);
      const secs = (Date.now() - t1) / 1000;
      metrics.retryThroughput = `${(BIG / MiB).toFixed(0)} MiB in ${secs.toFixed(2)} s (${(BIG / MiB / secs).toFixed(0)} MiB/s, includes UI polling)`;
    } finally {
      clearInterval(sampler);
      signalAll(sessionPids(), 'SIGCONT');
    }
    for (const n of ['q1.bin', 'q2.bin', 'q4.bin'])
      expect(await sha256(join(dest, n)), n).toBe(await sha256(join(FILES, n)));
    expect(existsSync(join(dest, 'q3.bin'))).toBe(false);
    expect(await partFiles(dest)).toEqual([]);
    const peak = Math.max(...rssSamples);
    const low = Math.min(...rssSamples);
    metrics.mainProcessRss = `${rssSamples.length} samples over 4 × ${BIG / MiB} MiB: min ${(low / MiB).toFixed(0)} MiB, peak ${(peak / MiB).toFixed(0)} MiB`;
    // Bounded memory: far below the size of a single file.
    expect(peak - low).toBeLessThan(BIG / 2);
    await page.getByRole('button', { name: 'Clear finished' }).click();
  });

  it('A11: network loss fails the active job, pauses the rest, and continues after reconnecting', async () => {
    const dest = join(TMP, 'lost');
    await mkdir(dest);
    await nextDialog('folder', dest);
    await downloadSelected(['lost1.bin', 'lost2.bin']);
    await page.waitForFunction(() => {
      const r = document.querySelector(
        '[data-testid="download-row"][data-name="lost1.bin"][data-state="downloading"]',
      );
      return Number(r?.getAttribute('data-bytes') ?? 0) > 0;
    });
    signalAll(sessionPids(), 'SIGSTOP');
    signalAll(sessionPids(), 'SIGKILL');
    await waitJob('lost1.bin', 'failed', 30_000);
    expect(await job('lost1.bin').getByTestId('job-error').innerText()).toMatch(
      /connection to the server was lost/i,
    );
    await page.getByTestId('queue-paused').waitFor();
    expect(await jobState('lost2.bin')).toBe('queued');
    expect(await job('lost2.bin').getByTestId('job-state').innerText()).toBe('Paused');
    expect(await partFiles(dest)).toEqual([]);
    await shot('33-failed-job.png');
    // Continue is only possible after reconnecting to the same server.
    expect(await page.getByRole('button', { name: 'Continue downloads' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Reconnect' }).click();
    await waitStatus('Connected');
    await page.getByRole('button', { name: 'Continue downloads' }).click();
    await waitJob('lost2.bin', 'completed', 120_000);
    await job('lost1.bin').getByRole('button', { name: 'Retry' }).click();
    await waitJob('lost1.bin', 'completed', 120_000);
    for (const n of ['lost1.bin', 'lost2.bin'])
      expect(await sha256(join(dest, n)), n).toBe(await sha256(join(FILES, n)));
    await page.getByRole('button', { name: 'Clear finished' }).click();
  });

  it('pending downloads: switching servers and quitting ask first; Keep / Stay is the default', async () => {
    const dest = join(TMP, 'pending');
    await mkdir(dest);
    await nextDialog('save', join(dest, 'pending.bin'));
    await fileRow('pending.bin').dblclick();
    await page.waitForFunction(() => {
      const r = document.querySelector('[data-testid="download-row"][data-state="downloading"]');
      return Number(r?.getAttribute('data-bytes') ?? 0) > 0;
    });
    signalAll(sessionPids(), 'SIGSTOP');
    // Switching server.
    await page.getByTestId('profile-item').filter({ hasText: 'Second server' }).click();
    await page
      .getByTestId('topbar')
      .getByRole('button', { name: 'Connect to Second server' })
      .click();
    const dlg = page.getByTestId('pending-dialog');
    await dlg.waitFor();
    expect(await dlg.innerText()).toMatch(/Connecting to Second server cancels it/);
    await shot('36-switch-with-pending.png');
    await dlg.getByRole('button', { name: 'Stay connected' }).click();
    await dlg.waitFor({ state: 'detached' });
    expect(await jobState('pending.bin')).toBe('downloading');
    // Closing the window.
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await dlg.waitFor();
    expect(await dlg.innerText()).toMatch(/1 download is still in progress/);
    await shot('35-quit-with-pending.png');
    await dlg.getByRole('button', { name: 'Keep downloading' }).click();
    await dlg.waitFor({ state: 'detached' });
    expect(await jobState('pending.bin')).toBe('downloading');
    expect((await partFiles(dest)).length).toBe(1);
    // Now quit for real: the download is cancelled and its partial file removed.
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await dlg.waitFor();
    const exited = new Promise<void>((res) => app!.process().once('exit', () => res()));
    await dlg.getByRole('button', { name: 'Cancel downloads and quit' }).click();
    await exited;
    app = null;
    signalAll(sessionPids(), 'SIGCONT');
    expect(await readdir(dest)).toEqual([]);
    const journal = JSON.parse(await readFile(join(USER_DATA, 'transfer-journal.json'), 'utf8'));
    expect(journal.entries).toEqual([]);
  });

  it('A13: a crash mid-download leaves a partial file that is offered for cleanup at startup', async () => {
    await launch();
    await connect('Fixture server');
    const dest = join(TMP, 'crash');
    await mkdir(dest);
    await writeFile(join(dest, 'unrelated.part'), 'not ours');
    await nextDialog('save', join(dest, 'q2.bin'));
    await fileRow('q2.bin').dblclick();
    await page.waitForFunction(() => {
      const r = document.querySelector('[data-testid="download-row"][data-state="downloading"]');
      return Number(r?.getAttribute('data-bytes') ?? 0) > 0;
    });
    signalAll(sessionPids(), 'SIGSTOP');
    const exited = new Promise<void>((res) => app!.process().once('exit', () => res()));
    app!.process().kill('SIGKILL');
    await exited;
    app = null;
    signalAll(sessionPids(), 'SIGCONT');
    const ours = (await partFiles(dest)).filter((n) => n !== 'unrelated.part');
    expect(ours).toHaveLength(1);
    await launch();
    const notice = page.getByTestId('orphan-notice');
    await notice.waitFor();
    expect(await notice.innerText()).toMatch(/1 unfinished download/);
    await notice.getByText('Show files').click();
    expect(await notice.innerText()).toContain(join(dest, ours[0]!));
    expect(await notice.innerText()).not.toContain('unrelated.part');
    await shot('37-orphan-partials.png');
    await notice.getByRole('button', { name: 'Delete partial files' }).click();
    await notice.waitFor({ state: 'detached' });
    await expect.poll(() => readdir(dest)).toEqual(['unrelated.part']);
    expect(await readFile(join(dest, 'unrelated.part'), 'utf8')).toBe('not ours');
  });
});
