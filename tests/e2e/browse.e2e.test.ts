// Browsing end-to-end (spec 6, acceptance A7 and A14): the real Electron app
// (production bundle, dev Electron binary) against a real local sshd. Slow
// listings and dropped connections are produced for real by freezing
// (SIGSTOP) or killing the server's per-connection sshd-session processes.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostFingerprint, keygen, pub, signCert } from '../integration/helpers/keys';
import { SshdInstance, findSshd, freePort } from '../integration/helpers/sshd';

const REPO = resolve(__dirname, '..', '..');
const TMP = resolve(__dirname, '..', '.tmp', `e2e-browse-${process.pid}-${Date.now()}`);
const SHOTS = join(REPO, 'docs', 'screenshots');
const CONFIG_HOME = join(TMP, 'config');
const USER_DATA = join(CONFIG_HOME, 'SimpleSFTP');
const K = (n: string): string => join(TMP, 'keys', n);
const PRINCIPAL = 'sftp-test-principal';
const USER = userInfo().username;
const bin = findSshd();
const built = existsSync(join(REPO, '.vite', 'build', 'main.cjs'));

let server: SshdInstance;
let app: ElectronApplication | null = null;
let page: Page;
let ROOT = ''; // remote path of the fixture root (= server default folder)
const PROFILE_FILES = randomUUID();
const PROFILE_BADSTART = randomUUID();
const metrics: Record<string, string> = {};
const DIRS = ['big', 'empty folder', 'link to nested', 'nested', 'no access', 'spaced name dir'];

const shot = (name: string): Promise<Buffer> => page.screenshot({ path: join(SHOTS, name) });
const location = (): Promise<string> =>
  page.getByRole('textbox', { name: 'Location' }).inputValue();
const rowNames = (): Promise<string[]> =>
  page
    .getByTestId('file-row')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-name') ?? ''));
const cssString = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
const row = (name: string) =>
  page.locator(`[data-testid="file-row"][data-name="${cssString(name)}"]`);
const itemCount = (): Promise<string> => page.getByTestId('item-count').innerText();
/** Wait until the view shows `path` with no listing outstanding. */
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
async function waitStatus(text: string): Promise<void> {
  await page
    .getByTestId('connection-status')
    .filter({ hasText: text })
    .waitFor({ timeout: 25_000 });
}
async function openRow(name: string): Promise<void> {
  await row(name).dblclick();
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

async function launch(): Promise<void> {
  app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [REPO],
    colorScheme: null,
    env: { ...process.env, XDG_CONFIG_HOME: CONFIG_HOME, ELECTRON_ENABLE_LOGGING: '0' },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 20_000 });
  // Native Save dialogs can't be driven under xvfb: record the request and cancel.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { saveRequests: string[] };
    g.saveRequests = [];
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const opts = args.at(-1) as { defaultPath?: string };
      g.saveRequests.push(opts.defaultPath ?? '');
      return { canceled: true, filePath: '' };
    }) as typeof dialog.showSaveDialog;
  });
}

async function connect(profileName: string): Promise<void> {
  await page.getByTestId('profile-item').filter({ hasText: profileName }).click();
  await page.getByTestId('topbar').getByRole('button', { name: 'Connect', exact: true }).click();
  await waitStatus('Connected');
}

describe.skipIf(!bin || !built)('Browsing end-to-end (real sshd, xvfb)', () => {
  beforeAll(async () => {
    const files = join(TMP, 'sftp-root');
    await mkdir(join(TMP, 'keys'), { recursive: true });
    await mkdir(SHOTS, { recursive: true });
    await mkdir(join(files, 'nested', 'level 2', 'level 3'), { recursive: true });
    await writeFile(join(files, 'nested', 'level 2', 'level 3', 'deep file.txt'), 'deep\n');
    await writeFile(join(files, 'nested', 'level 2', 'notes.md'), '# notes\n');
    await writeFile(join(files, 'nested', 'inside.txt'), 'x'.repeat(2048));
    await mkdir(join(files, 'empty folder'));
    await mkdir(join(files, 'spaced name dir'));
    await writeFile(join(files, 'spaced name dir', 'a b c.txt'), 'abc');
    await mkdir(join(files, '.hidden-dir'));
    await writeFile(join(files, '.hidden-file'), 'h');
    await writeFile(join(files, 'Ünïcødé ファイル 📄.txt'), 'u'.repeat(10));
    await writeFile(join(files, 'report 2026.pdf'), Buffer.alloc(1536 * 1024));
    await writeFile(join(files, 'zero.bin'), '');
    await writeFile(join(files, 'line\nbreak.txt'), 'x');
    await writeFile(join(files, '<img src=x onerror=alert(1)>.txt'), 'x');
    await writeFile(join(files, '$(touch pwned).sh'), 'echo no');
    await utimes(join(files, 'report 2026.pdf'), 1_700_000_000, 1_700_000_000);
    await mkdir(join(files, 'no access'));
    await writeFile(join(files, 'no access', 'secret.txt'), 's');
    await symlink(join(files, 'nested'), join(files, 'link to nested'));
    await symlink('report 2026.pdf', join(files, 'link to report'));
    await symlink('missing-target', join(files, 'broken link'));
    await mkdir(join(files, 'big'));
    await Promise.all(
      Array.from({ length: 10_000 }, (_, i) =>
        writeFile(
          join(files, 'big', `file-${String(i).padStart(5, '0')}.dat`),
          Buffer.alloc(i % 5000),
        ),
      ),
    );
    await chmod(join(files, 'no access'), 0o000);
    ROOT = realpathSync(files);

    keygen(K('host'), 'ed25519');
    keygen(K('ca'), 'ed25519');
    keygen(K('ed'), 'ed25519');
    signCert({ caPath: K('ca'), keyPath: K('ed'), principals: [PRINCIPAL], validity: '-5m:+2h' });
    server = new SshdInstance(bin!, {
      dir: join(TMP, 'server'),
      port: await freePort(),
      hostKeys: [K('host')],
      sftpRoot: files,
      trustedUserCa: pub(K('ca')),
      principals: [PRINCIPAL],
    });
    await server.start();

    // Seed config in the app's own on-disk format (creating profiles and
    // trusting hosts through the UI is covered by app.e2e.test.ts).
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
      downloadDirectory: null,
    };
    await writeFile(
      join(USER_DATA, 'profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: [
          { ...base, id: PROFILE_FILES, name: 'Fixture files', initialRemoteDirectory: null },
          {
            ...base,
            id: PROFILE_BADSTART,
            name: 'Missing start folder',
            initialRemoteDirectory: '/no/such/start',
          },
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
        lastSelectedProfileId: PROFILE_FILES,
        window: { width: 1280, height: 800, maximized: false },
      }),
    );
    await launch();
  }, 240_000);

  afterAll(async () => {
    if (Object.keys(metrics).length) {
      // Vitest hides console output of passing tests, so keep the numbers in a file too.
      await writeFile(
        join(REPO, 'docs', 'e2e-browse-metrics.json'),
        `${JSON.stringify({ measuredAt: new Date().toISOString(), environment: 'Linux, xvfb software rendering, sshd on 127.0.0.1', ...metrics }, null, 2)}\n`,
      );
    }
    if (server) signalAll(sessionPids(), 'SIGCONT');
    await app?.close().catch(() => undefined);
    await server?.stop();
    await chmod(join(TMP, 'sftp-root', 'no access'), 0o755).catch(() => undefined);
    if (!process.env.KEEP_TEST_TMP) await rm(TMP, { recursive: true, force: true });
  });

  it('opens the server default folder: directories first, metadata, em dashes, hidden files hidden', async () => {
    await connect('Fixture files');
    await waitLocation(ROOT);
    const names = await rowNames();
    // Directories (incl. the link to a folder) first, by name; then files.
    expect(names.slice(0, 6)).toEqual(DIRS);
    expect(names.slice(6).sort()).toEqual(
      [
        '$(touch pwned).sh',
        '<img src=x onerror=alert(1)>.txt',
        'broken link',
        'line\nbreak.txt',
        'link to report',
        'report 2026.pdf',
        'zero.bin',
        'Ünïcødé ファイル 📄.txt',
      ].sort(),
    );
    expect(names).not.toContain('.hidden-file');
    expect(await itemCount()).toMatch(/· 2 hidden/);
    // Unknown metadata is an em dash, never 0.
    expect(await row('nested').locator('.cell-size').innerText()).toBe('—');
    expect(await row('zero.bin').locator('.cell-size').innerText()).toBe('0 B');
    expect(await row('report 2026.pdf').locator('.cell-size').innerText()).toBe('1.5 MiB');
    expect(await row('report 2026.pdf').locator('.cell-modified').innerText()).toMatch(/2023/);
    // Names are text: markup is not parsed, control characters are visible.
    expect(await row('<img src=x onerror=alert(1)>.txt').innerText()).toContain(
      '<img src=x onerror=alert(1)>.txt',
    );
    expect(await page.locator('.file-table img').count()).toBe(0);
    expect(await row('line\nbreak.txt').locator('.name-text').innerText()).toBe(
      'line\u240abreak.txt',
    );
    expect(await row('Ünïcødé ファイル 📄.txt').count()).toBe(1);
    // Symlinks: distinct icon and type.
    expect(await row('link to nested').locator('[data-icon="symlink"]').count()).toBe(1);
    expect(await row('link to nested').locator('.cell-type').innerText()).toBe('Link to folder');
    expect(await row('link to report').locator('.cell-type').innerText()).toBe('Link to file');
    expect(await row('broken link').locator('.cell-type').innerText()).toBe('Broken link');
    expect(await page.getByTestId('download-button').isDisabled()).toBe(true);
    await shot('11-browser-root.png');
  });

  it('Show hidden files reveals dot files; the filter is case-insensitive and only searches this folder', async () => {
    await page.getByLabel('Show hidden files').check();
    expect(await rowNames()).toEqual(expect.arrayContaining(['.hidden-dir', '.hidden-file']));
    expect(await itemCount()).not.toMatch(/hidden/);
    await shot('12-hidden-files.png');
    await page.getByLabel('Show hidden files').uncheck();
    await page.getByLabel('Filter this folder').fill('REPORT');
    expect(await rowNames()).toEqual(['link to report', 'report 2026.pdf']);
    await page.getByLabel('Filter this folder').fill('deep file'); // exists only in a subfolder
    await page.getByTestId('browser-state-no-match').waitFor();
    expect(await page.getByTestId('browser-state-no-match').innerText()).toMatch(
      /only searches this folder/,
    );
    await page.getByLabel('Filter this folder').fill('');
  });

  it('nested navigation: double-click, breadcrumbs, back, forward, parent, home and the location field', async () => {
    await openRow('nested');
    await waitLocation(`${ROOT}/nested`);
    await openRow('level 2');
    await waitLocation(`${ROOT}/nested/level 2`);
    await openRow('level 3');
    await waitLocation(`${ROOT}/nested/level 2/level 3`);
    expect(await rowNames()).toEqual(['deep file.txt']);
    const crumbs = page.getByTestId('breadcrumbs').getByRole('button');
    expect(await crumbs.last().innerText()).toBe('level 3');
    expect(await crumbs.last().getAttribute('aria-current')).toBe('page');
    await shot('13-nested-breadcrumbs.png');
    await page
      .getByTestId('breadcrumbs')
      .getByRole('button', { name: 'nested', exact: true })
      .click();
    await waitLocation(`${ROOT}/nested`);
    await page.getByRole('button', { name: 'Back' }).click();
    await waitLocation(`${ROOT}/nested/level 2/level 3`);
    await page.getByRole('button', { name: 'Forward' }).click();
    await waitLocation(`${ROOT}/nested`);
    expect(await page.getByRole('button', { name: 'Forward' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Parent folder' }).click();
    await waitLocation(ROOT);
    // Keyboard: Alt+Left goes back.
    await page.getByTestId('file-table').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await waitLocation(`${ROOT}/nested`);
    // Location field: relative input resolves against the current folder.
    const loc = page.getByRole('textbox', { name: 'Location' });
    await loc.fill('../spaced name dir');
    await loc.press('Enter');
    await waitLocation(`${ROOT}/spaced name dir`);
    expect(await rowNames()).toEqual(['a b c.txt']);
    await page.getByRole('button', { name: 'Server default folder' }).click();
    await waitLocation(ROOT);
  });

  it('explicit navigation through a symlink to a folder; links to files are not downloadable', async () => {
    await openRow('link to nested');
    await waitLocation(`${ROOT}/link to nested`);
    expect(await rowNames()).toEqual(['level 2', 'inside.txt']);
    await page.getByRole('button', { name: 'Back' }).click();
    await waitLocation(ROOT);
    await openRow('link to report');
    expect(await page.getByTestId('browser-message').innerText()).toMatch(
      /is a link\. Links can't be downloaded/,
    );
    await openRow('broken link');
    expect(await page.getByTestId('browser-message').innerText()).toMatch(/broken link/);
    expect(await location()).toBe(ROOT);
    await shot('19-symlinks.png');
  });

  it('sorting by name, size and modified keeps directories first', async () => {
    await page.getByRole('columnheader', { name: 'Size' }).getByRole('button').click();
    let names = await rowNames();
    const files = names.filter((n) => !DIRS.includes(n));
    expect(names.slice(0, 6)).toEqual(DIRS);
    expect(files[0]).toBe('report 2026.pdf'); // largest first
    expect(await page.getByRole('columnheader', { name: 'Size' }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    await shot('14-sorted-by-size.png');
    await page.getByRole('columnheader', { name: 'Modified' }).getByRole('button').click();
    names = await rowNames();
    expect(names.filter((n) => n.endsWith('.pdf') || n === 'zero.bin').at(-1)).toBe(
      'report 2026.pdf',
    ); // oldest last
    const nameSort = page.getByRole('columnheader', { name: 'Name' });
    await nameSort.getByRole('button').click();
    expect(await nameSort.getAttribute('aria-sort')).toBe('ascending');
    await nameSort.getByRole('button').click();
    expect(await nameSort.getAttribute('aria-sort')).toBe('descending');
    expect((await rowNames()).slice(0, 6)).toEqual([...DIRS].reverse());
    await nameSort.getByRole('button').click();
    expect(await nameSort.getAttribute('aria-sort')).toBe('ascending');
    expect((await rowNames()).slice(0, 6)).toEqual(DIRS);
  });

  it('single and multiple selection with mouse and keyboard; double-click on a file only raises the download stub', async () => {
    await row('zero.bin').click();
    await row('$(touch pwned).sh').click({ modifiers: ['Shift'] });
    expect(await itemCount()).toMatch(/selected/);
    const rangeCount = await page.locator('[data-testid="file-row"][aria-selected="true"]').count();
    expect(rangeCount).toBeGreaterThan(2);
    await row('nested').click({ modifiers: ['Control'] });
    expect(await page.locator('[data-testid="file-row"][aria-selected="true"]').count()).toBe(
      rangeCount + 1,
    );
    await shot('15-multi-select.png');
    await page.getByTestId('file-table').focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await page.locator('[data-testid="file-row"][aria-selected="true"]').count()).toBe(3);
    await page.keyboard.press('Control+a');
    expect(await itemCount()).toMatch(new RegExp(`· ${(await rowNames()).length} selected`));
    await page.keyboard.press('Escape');
    expect(await itemCount()).not.toMatch(/selected/);
    await openRow('$(touch pwned).sh');
    // Opening a file only offers to download it (native Save dialog, cancelled here).
    await expect
      .poll(() =>
        app!.evaluate(() => (globalThis as unknown as { saveRequests: string[] }).saveRequests),
      )
      .toEqual([expect.stringMatching(/\/\$\(touch pwned\)\.sh$/)]);
    expect(existsSync(join(TMP, 'sftp-root', 'pwned'))).toBe(false);
    expect(await location()).toBe(ROOT);
    // Enter on a folder navigates.
    await page.getByTestId('file-table').focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await waitLocation(`${ROOT}/big`);
    await page.getByRole('button', { name: 'Back' }).click();
    await waitLocation(ROOT);
  });

  it('distinct empty, permission-denied and not-found states', async () => {
    await openRow('empty folder');
    await page.getByTestId('browser-state-empty').waitFor();
    await shot('16-empty-folder.png');
    await page.getByRole('button', { name: 'Back' }).click();
    await waitLocation(ROOT);
    await openRow('no access');
    await page.getByTestId('browser-state-denied').waitFor();
    expect(await page.getByTestId('browser-state-denied').innerText()).toMatch(
      /doesn't allow your account/,
    );
    await shot('17-permission-denied.png');
    await page.getByTestId('browser-state-denied').getByRole('button', { name: 'Go back' }).click();
    await waitLocation(ROOT);
    const loc = page.getByRole('textbox', { name: 'Location' });
    await loc.fill(`${ROOT}/does not exist`);
    await loc.press('Enter');
    await page.getByTestId('browser-state-not-found').waitFor();
    await shot('18-not-found.png');
    await page
      .getByTestId('browser-state-not-found')
      .getByRole('button', { name: 'Open parent folder' })
      .click();
    await waitLocation(ROOT);
  });

  it('A14: a 10,000-entry folder stays navigable and filterable (virtualized)', async () => {
    let t0 = Date.now();
    await openRow('big');
    await waitLocation(`${ROOT}/big`);
    await row('file-00000.dat').waitFor();
    metrics.open10k_ms = String(Date.now() - t0);
    expect(await itemCount()).toBe('10000 items');
    const domRows = await page.getByTestId('file-row').count();
    metrics.domRowsRendered = String(domRows);
    expect(domRows).toBeLessThan(80);

    // Scroll through the whole list while sampling frame gaps in the page.
    const scroll = await page.evaluate(async () => {
      const el = document.querySelector('[data-testid="file-scroller"]') as HTMLElement;
      const gaps: number[] = [];
      let last = performance.now();
      let running = true;
      const tick = (t: number): void => {
        gaps.push(t - last);
        last = t;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const start = performance.now();
      const steps = 100;
      for (let i = 1; i <= steps; i++) {
        el.scrollTop = (el.scrollHeight - el.clientHeight) * (i / steps);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      const total = performance.now() - start;
      await new Promise((r) => setTimeout(r, 100));
      running = false;
      const sorted = [...gaps].sort((a, b) => a - b);
      return {
        totalMs: Math.round(total),
        frames: gaps.length,
        maxFrameMs: Math.round(sorted.at(-1) ?? 0),
        p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      };
    });
    metrics.scroll10k = `100 scroll steps top→bottom in ${scroll.totalMs} ms; frame gap p95 ${scroll.p95FrameMs} ms, max ${scroll.maxFrameMs} ms`;
    await row('file-09999.dat').waitFor();
    expect(scroll.maxFrameMs).toBeLessThan(500);
    await shot('20-10k-folder-scrolled.png');

    // Keyboard: End/Home over 10,000 rows.
    await page.getByTestId('file-table').focus();
    await page.keyboard.press('Home');
    await row('file-00000.dat').waitFor();
    t0 = Date.now();
    await page.keyboard.press('End');
    await page.locator('[data-name="file-09999.dat"][aria-selected="true"]').waitFor();
    metrics.keyboardEnd10k_ms = String(Date.now() - t0);

    // Filter typing, one key at a time.
    const filter = page.getByLabel('Filter this folder');
    await filter.focus();
    t0 = Date.now();
    await filter.pressSequentially('0999', { delay: 0 });
    await expect.poll(itemCount, { timeout: 5000 }).toBe('11 of 10000 items · 1 selected'); // file-09999.dat is still visible, so it stays selected
    metrics.filter10k_type4keys_ms = String(Date.now() - t0);
    const perKey = await page.evaluate(async () => {
      const input = document.querySelector(
        'input[aria-label="Filter this folder"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const times: number[] = [];
      for (const q of ['f', 'fi', 'fil', 'file', 'file-', 'file-0', 'file-00', 'file-001']) {
        const t = performance.now();
        setter.call(input, q);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
        times.push(performance.now() - t);
      }
      return {
        max: Math.round(Math.max(...times)),
        avg: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      };
    });
    metrics.filter10k_perKeystroke = `avg ${perKey.avg} ms, max ${perKey.max} ms (input → painted)`;
    await expect.poll(itemCount).toBe('100 of 10000 items');
    expect(perKey.max).toBeLessThan(500);
    await shot('21-10k-folder-filtered.png');
    await filter.fill('');
    await page.getByRole('button', { name: 'Back' }).click();
    await waitLocation(ROOT);
  });

  it('slow listing: responsive loading state; cancel and superseded responses never replace the view', async () => {
    // Freeze the server side of our connection: the next listing hangs.
    let frozen = sessionPids();
    expect(frozen.length).toBeGreaterThan(0);
    signalAll(frozen, 'SIGSTOP');
    const t0 = Date.now();
    await openRow('nested');
    await page.getByTestId('browser-state-loading').waitFor({ timeout: 3000 });
    metrics.loadingStateShown_ms = String(Date.now() - t0);
    expect(await page.getByTestId('browser-state-loading').innerText()).toContain(`${ROOT}/nested`);
    // The UI stays responsive while the server is stuck.
    await page.getByLabel('Show hidden files').check();
    expect(await page.getByLabel('Show hidden files').isChecked()).toBe(true);
    await page.getByLabel('Show hidden files').uncheck();
    await shot('22-slow-listing-loading.png');
    await page.getByTestId('browser-state-loading').getByRole('button', { name: 'Cancel' }).click();
    await page.getByTestId('browser-state-loading').waitFor({ state: 'detached' });
    expect(await location()).toBe(ROOT);
    signalAll(frozen, 'SIGCONT'); // the cancelled listing now answers...
    await page.waitForTimeout(1500);
    expect(await location()).toBe(ROOT); // ...and is ignored
    expect(await rowNames()).toContain('report 2026.pdf');

    // Superseded: start one request, then another; only the last one wins.
    frozen = sessionPids();
    signalAll(frozen, 'SIGSTOP');
    await openRow('nested');
    await page.getByTestId('browser-state-loading').waitFor();
    const loc = page.getByRole('textbox', { name: 'Location' });
    await loc.fill(`${ROOT}/empty folder`);
    await loc.press('Enter');
    await expect
      .poll(() => page.getByTestId('browser-state-loading').innerText())
      .toContain('empty folder');
    signalAll(frozen, 'SIGCONT');
    await page.getByTestId('browser-state-empty').waitFor();
    await page.waitForTimeout(1000);
    expect(await location()).toBe(`${ROOT}/empty folder`);
    await page.getByRole('button', { name: 'Server default folder' }).click();
    await waitLocation(ROOT);
  });

  it('disconnect during browsing: lost connection, user disconnect mid-listing, and reconnect', async () => {
    // Connection lost: kill the server side of our session.
    signalAll(sessionPids(), 'SIGKILL');
    await page.getByTestId('browser-state-disconnected').waitFor({ timeout: 15_000 });
    expect(await page.getByTestId('browser-state-disconnected').innerText()).toMatch(/was lost/);
    await shot('23-connection-lost.png');
    await page
      .getByTestId('browser-state-disconnected')
      .getByRole('button', { name: 'Reconnect' })
      .click();
    await waitStatus('Connected');
    await waitLocation(ROOT);

    // User disconnects while a listing is stuck on an unresponsive server.
    const frozen = sessionPids();
    signalAll(frozen, 'SIGSTOP');
    await openRow('nested');
    await page.getByTestId('browser-state-loading').waitFor();
    const t0 = Date.now();
    await page.getByTestId('topbar').getByRole('button', { name: 'Disconnect' }).click();
    await page.getByTestId('browser-state-disconnected').waitFor({ timeout: 10_000 });
    metrics.disconnectFrozenServer_ms = String(Date.now() - t0);
    signalAll(frozen, 'SIGCONT');
    expect(await page.getByTestId('browser-state-disconnected').innerText()).toMatch(
      /Disconnected from Fixture files/,
    );
    expect(await page.getByTestId('browser').count()).toBe(0);
  });

  it('an inaccessible initial folder offers the server default folder', async () => {
    await connect('Missing start folder');
    await page.getByTestId('browser-state-not-found').waitFor();
    expect(await page.getByTestId('initial-fallback').innerText()).toMatch(
      /start folder couldn't be opened/,
    );
    await shot('24-initial-folder-fallback.png');
    await page.getByRole('button', { name: 'Open server default folder' }).click();
    await waitLocation(ROOT);
    await page.getByTestId('topbar').getByRole('button', { name: 'Disconnect' }).click();
    await waitStatus('Disconnected');
  });
});
