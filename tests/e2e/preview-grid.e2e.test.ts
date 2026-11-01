// Preview-mode grid: list and two thumbnail sizes against real fixture images
// on a real local sshd, plus persistence of the choice across a restart.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostFingerprint, keygen, pub, signCert } from '../integration/helpers/keys';
import { SshdInstance, findSshd, freePort } from '../integration/helpers/sshd';

const REPO = resolve(__dirname, '..', '..');
const TMP = resolve(__dirname, '..', '.tmp', `e2e-grid-${process.pid}-${Date.now()}`);
const SHOTS = join(REPO, 'docs', 'screenshots');
const CONFIG_HOME = join(TMP, 'config');
const USER_DATA = join(CONFIG_HOME, 'SimpleSFTP');
const IMAGES = resolve(__dirname, '..', 'fixtures', 'images');
const K = (n: string): string => join(TMP, 'keys', n);
const PRINCIPAL = 'sftp-test-principal';
const PROFILE = randomUUID();
const bin = findSshd();
const built = existsSync(join(REPO, '.vite', 'build', 'main.cjs'));

let server: SshdInstance;
let app: ElectronApplication | null = null;
let page: Page;
let FILES = '';

const shot = (name: string): Promise<Buffer> => page.screenshot({ path: join(SHOTS, name) });
const tile = (name: string) => page.locator(`[data-testid="preview-tile"][data-name="${name}"]`);

function sessionPids(): number[] {
  const rows = execFileSync('ps', ['-e', '-o', 'pid=,ppid='])
    .toString()
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const out: number[] = [];
  const visit = (p: number): void => {
    for (const [c, pp] of rows) {
      if (pp !== p) continue;
      out.push(c);
      visit(c);
    }
  };
  visit(server.pid!);
  return out;
}

async function launch(): Promise<void> {
  app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [REPO],
    colorScheme: null,
    env: { ...process.env, XDG_CONFIG_HOME: CONFIG_HOME, ELECTRON_ENABLE_LOGGING: '0' },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 20_000 });
  await app.evaluate(({ dialog: d }) => {
    const g = globalThis as unknown as { saveRequests: string[] };
    g.saveRequests = [];
    d.showSaveDialog = (async (...args: unknown[]) => {
      const opts = args.at(-1) as { defaultPath?: string };
      g.saveRequests.push(opts.defaultPath ?? '');
      return { canceled: true, filePath: '' };
    }) as typeof d.showSaveDialog;
  });
}

async function connect(): Promise<void> {
  await page.getByTestId('profile-item').filter({ hasText: 'Images' }).click();
  await page.getByTestId('topbar').getByRole('button', { name: 'Connect', exact: true }).click();
  await page
    .getByTestId('connection-status')
    .filter({ hasText: 'Connected' })
    .waitFor({ timeout: 25_000 });
  await page.waitForFunction(
    (p) => {
      const b = document.querySelector('[data-testid="browser"]');
      return b?.getAttribute('data-view-path') === p && b.getAttribute('data-busy') === 'false';
    },
    FILES,
    { timeout: 15_000 },
  );
}

async function thumbReady(name: string): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const img = document.querySelector(
        `[data-testid="preview-tile"][data-name="${n}"] img`,
      ) as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    },
    name,
    { timeout: 20_000 },
  );
}

describe.skipIf(!bin || !built)('Preview grid end-to-end (real sshd, xvfb)', () => {
  beforeAll(async () => {
    const files = join(TMP, 'sftp-root');
    await mkdir(join(TMP, 'keys'), { recursive: true });
    await mkdir(SHOTS, { recursive: true });
    await mkdir(join(files, 'Album'), { recursive: true });
    for (const f of ['sunset.png', 'night.jpg', 'blink.gif', 'meadow.webp'])
      await copyFile(join(IMAGES, f), join(files, f));
    await writeFile(join(files, 'notes.txt'), 'not an image\n');
    await writeFile(join(files, 'fake.png'), 'plain text renamed to png\n');
    await writeFile(join(files, 'Album', 'inside.txt'), 'nested\n');
    FILES = realpathSync(files);

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

    const now = new Date().toISOString();
    await mkdir(USER_DATA, { recursive: true });
    await writeFile(
      join(USER_DATA, 'profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: [
          {
            id: PROFILE,
            name: 'Images',
            createdAt: now,
            updatedAt: now,
            host: '127.0.0.1',
            port: server.cfg.port,
            username: userInfo().username,
            authMode: 'privateKeyAndCertificate',
            privateKeyPath: K('ed'),
            certificatePath: K('ed-cert.pub'),
            initialRemoteDirectory: null,
            downloadDirectory: null,
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
        lastSelectedProfileId: PROFILE,
        window: { width: 1280, height: 800, maximized: false },
      }),
    );
    await launch();
    await connect();
  }, 120_000);

  afterAll(async () => {
    if (server) {
      for (const p of sessionPids()) {
        try {
          process.kill(p, 'SIGCONT');
        } catch {
          /* already gone */
        }
      }
    }
    app?.process().kill('SIGKILL');
    await server?.stop();
    if (!process.env.KEEP_TEST_TMP) await rm(TMP, { recursive: true, force: true });
  });

  it('list mode is the default and still shows the file table', async () => {
    expect(await page.getByTestId('browser').getAttribute('data-view-mode')).toBe('list');
    expect(await page.getByTestId('view-list').getAttribute('aria-pressed')).toBe('true');
    await page.getByTestId('file-row').filter({ hasText: 'sunset.png' }).waitFor();
    await shot('50-list-mode.png');
  });

  it('preview mode shows thumbnails at the small size, and icons for other files', async () => {
    await page.getByTestId('view-preview').click();
    expect(await page.getByTestId('browser').getAttribute('data-view-mode')).toBe('preview');
    expect(await page.getByTestId('browser').getAttribute('data-preview-size')).toBe('small');
    await thumbReady('sunset.png');
    await thumbReady('night.jpg');
    const sunset = await tile('sunset.png')
      .locator('img')
      .evaluate((img: HTMLImageElement) => img.naturalWidth);
    expect(sunset).toBeGreaterThan(0);
    expect(sunset).toBeLessThanOrEqual(160);
    const box = await tile('sunset.png').boundingBox();
    expect(box!.width).toBeLessThan(200);
    expect(await tile('notes.txt').locator('img').count()).toBe(0);
    expect(await tile('Album').locator('img').count()).toBe(0);
    await expect
      .poll(async () => tile('fake.png').locator('[data-thumb]').getAttribute('data-thumb'))
      .toBe('icon');
    await shot('51-preview-small.png');
  });

  it('large previews are a bigger tile and a bigger thumbnail', async () => {
    const smallBox = (await tile('sunset.png').boundingBox())!;
    const smallPx = await tile('sunset.png')
      .locator('img')
      .evaluate((img: HTMLImageElement) => img.naturalWidth);
    await page.getByTestId('preview-size-large').click();
    expect(await page.getByTestId('browser').getAttribute('data-preview-size')).toBe('large');
    await thumbReady('sunset.png');
    const largePx = await tile('sunset.png')
      .locator('img')
      .evaluate((img: HTMLImageElement) => img.naturalWidth);
    const largeBox = (await tile('sunset.png').boundingBox())!;
    expect(largePx).toBeGreaterThan(smallPx);
    expect(largePx).toBeLessThanOrEqual(320);
    expect(largeBox.width).toBeGreaterThan(smallBox.width + 40);
    await shot('52-preview-large.png');
  });

  it('selection, download, full preview and folder open still work', async () => {
    await tile('sunset.png').click();
    expect(await page.getByTestId('download-button').innerText()).toMatch(/Download \(1\)/);
    await page.getByTestId('download-button').click();
    await expect
      .poll(
        async () =>
          (
            await app!.evaluate(
              () => (globalThis as unknown as { saveRequests: string[] }).saveRequests,
            )
          ).length,
      )
      .toBe(1);
    await tile('night.jpg').click();
    await page.keyboard.press('Space');
    await page.getByTestId('preview-dialog').waitFor();
    await page.waitForFunction(() => {
      const img = document.querySelector(
        '[data-testid="preview-image"]',
      ) as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    });
    expect(await page.getByTestId('preview-image').getAttribute('data-mime')).toBe('image/jpeg');
    await page.keyboard.press('Escape');
    await page.getByTestId('preview-dialog').waitFor({ state: 'detached' });
    await tile('Album').dblclick();
    await page.waitForFunction(
      (root) => {
        const b = document.querySelector('[data-testid="browser"]');
        const path = b?.getAttribute('data-view-path') ?? '';
        return (
          path.startsWith(root) &&
          path.endsWith('/Album') &&
          b?.getAttribute('data-busy') === 'false'
        );
      },
      FILES,
      { timeout: 15_000 },
    );
    expect(await tile('inside.txt').count()).toBe(1);
  });

  it('the view and size persist across a restart, and the cache holds no key material', async () => {
    await expect
      .poll(async () => JSON.parse(await readFile(join(USER_DATA, 'settings.json'), 'utf8')))
      .toMatchObject({ browserView: 'preview', previewSize: 'large' });
    const key = await readFile(K('ed'));
    const cacheDir = join(USER_DATA, 'preview-cache');
    const names = await readdir(cacheDir);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toMatch(/^[a-f0-9]{64}$/);
      const body = await readFile(join(cacheDir, name));
      expect(body.includes(key)).toBe(false);
    }
    await app!.close();
    app = null;
    await launch();
    await connect();
    expect(await page.getByTestId('browser').getAttribute('data-view-mode')).toBe('preview');
    expect(await page.getByTestId('browser').getAttribute('data-preview-size')).toBe('large');
    await thumbReady('sunset.png');
    expect(await page.getByTestId('view-preview').getAttribute('aria-pressed')).toBe('true');
    expect(await page.getByTestId('preview-size-large').getAttribute('aria-pressed')).toBe('true');
  });
});
