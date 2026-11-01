// Image preview end-to-end (version 2 feature, outside SPEC.md): the real
// Electron app (production bundle) against a real local sshd under xvfb.
// Covers every fixture format, an SVG that tries to run script and fetch over
// the network (must not), a non-image named .png, a damaged PNG, the 20 MiB
// cap, missing / denied files, disconnect mid-preview, rapid Prev/Next with a
// frozen server (stale responses never shown), keyboard and focus, the CSP,
// and that no image bytes are written to local disk.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostFingerprint, keygen, pub, signCert } from '../integration/helpers/keys';
import { SshdInstance, findSshd, freePort } from '../integration/helpers/sshd';

const REPO = resolve(__dirname, '..', '..');
const TMP = resolve(__dirname, '..', '.tmp', `e2e-preview-${process.pid}-${Date.now()}`);
const SHOTS = join(REPO, 'docs', 'screenshots');
const CONFIG_HOME = join(TMP, 'config');
// The app's TMPDIR: short, since Chromium puts a socket path under it.
let APP_TMP = '';
const USER_DATA = join(CONFIG_HOME, 'SimpleSFTP');
const IMAGES = resolve(__dirname, '..', 'fixtures', 'images');
const K = (n: string): string => join(TMP, 'keys', n);
const PRINCIPAL = 'sftp-test-principal';
const PROFILE = randomUUID();
const MiB = 1024 ** 2;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Unique bytes in the SVG and a PNG; searched for on local disk afterwards. */
const MARKER = `preview-marker-${randomBytes(12).toString('hex')}`;
const bin = findSshd();
const built = existsSync(join(REPO, '.vite', 'build', 'main.cjs'));

let server: SshdInstance;
let http: Server;
let httpHits: string[] = [];
let app: ElectronApplication | null = null;
let page: Page;
let FILES = '';

const IMAGE_ORDER = [
  'blink.gif',
  'denied.png',
  'dusk.avif',
  'evil.svg',
  'favicon.ico',
  'huge.png',
  'marked.png',
  'meadow.webp',
  'missing.png',
  'night.jpg',
  'not-an-image.png',
  'sunset.png',
  'tiles.bmp',
  'truncated.png',
];

const shot = (name: string): Promise<Buffer> => page.screenshot({ path: join(SHOTS, name) });
const row = (name: string) => page.locator(`[data-testid="file-row"][data-name="${name}"]`);
const dialog = () => page.getByTestId('preview-dialog');
const stage = () => page.getByTestId('preview-stage');

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
const signalAll = (pids: number[], sig: NodeJS.Signals): void => {
  for (const p of pids) {
    try {
      process.kill(p, sig);
    } catch {
      // already gone
    }
  }
};

async function waitStatus(text: string): Promise<void> {
  await page
    .getByTestId('connection-status')
    .filter({ hasText: text })
    .waitFor({ timeout: 25_000 });
}
async function waitFolder(): Promise<void> {
  await page.waitForFunction(
    (p) => {
      const b = document.querySelector('[data-testid="browser"]');
      return b?.getAttribute('data-view-path') === p && b.getAttribute('data-busy') === 'false';
    },
    FILES,
    { timeout: 15_000 },
  );
}
/** Wait until the stage shows `name` settled (ready with dimensions, or error). */
async function settled(name: string, want: 'ready' | 'error'): Promise<void> {
  await page.waitForFunction(
    ([n, w]) => {
      const s = document.querySelector('[data-testid="preview-stage"]');
      if (s?.getAttribute('data-name') !== n || s.getAttribute('data-state') !== w) return false;
      if (w === 'error') return true;
      const img = s.querySelector('img');
      return (
        !!img &&
        img.complete &&
        img.naturalWidth > 0 &&
        /\d+ × \d+ px/.test(
          document.querySelector('[data-testid="preview-meta"]')?.textContent ?? '',
        )
      );
    },
    [name, want] as const,
    { timeout: 20_000 },
  );
}
async function openPreview(name: string): Promise<void> {
  await row(name).click();
  await page.keyboard.press('Space');
  await dialog().waitFor();
}
async function closePreview(): Promise<void> {
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' });
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe.skipIf(!bin || !built)('Image preview end-to-end (real sshd, xvfb)', () => {
  beforeAll(async () => {
    const files = join(TMP, 'sftp-root');
    await mkdir(join(TMP, 'keys'), { recursive: true });
    await mkdir(SHOTS, { recursive: true });
    await mkdir(files, { recursive: true });
    APP_TMP = await mkdtemp(join(tmpdir(), 'sftp-preview-'));

    // Local HTTP server: any request means remote content was fetched.
    http = createServer((req, res) => {
      httpHits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_SIG);
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const H = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

    for (const f of await readdir(IMAGES)) await copyFile(join(IMAGES, f), join(files, f));
    await writeFile(
      join(files, 'evil.svg'),
      `<?xml version="1.0"?>
<!-- ${MARKER} -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="360" onload="window.top.svgOnload = 1; fetch('${H}/svg-onload')">
  <style>@import url("${H}/svg-css-import");</style>
  <rect width="600" height="360" fill="#1d3557"/>
  <circle cx="470" cy="110" r="70" fill="#e9c46a"/>
  <text x="40" y="200" font-family="sans-serif" font-size="30" fill="#fff">SVG preview: scripts never run</text>
  <image href="${H}/svg-image.png" x="0" y="0" width="10" height="10"/>
  <script>window.top.svgScriptRan = 1; document.title = 'SVG-SCRIPT-RAN'; fetch('${H}/svg-script'); new Image().src = '${H}/svg-script-img';</script>
</svg>
`,
    );
    // A real PNG with the marker in a tEXt chunk (ignored by decoders).
    const sunset = await readFile(join(IMAGES, 'sunset.png'));
    const text = Buffer.from(`Comment\0${MARKER}`);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(text.length);
    const { crc32 } = await import('node:zlib');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt'), text])) >>> 0);
    await writeFile(
      join(files, 'marked.png'),
      Buffer.concat([
        sunset.subarray(0, 33),
        len,
        Buffer.from('tEXt'),
        text,
        crc,
        sunset.subarray(33),
      ]),
    );
    await writeFile(join(files, 'not-an-image.png'), 'Plain text, renamed to .png.\n');
    await writeFile(join(files, 'truncated.png'), Buffer.concat([PNG_SIG, randomBytes(512)]));
    await writeFile(join(files, 'huge.png'), Buffer.concat([PNG_SIG, randomBytes(21 * MiB)]));
    await copyFile(join(IMAGES, 'sunset.png'), join(files, 'denied.png'));
    await chmod(join(files, 'denied.png'), 0o000);
    await copyFile(join(IMAGES, 'sunset.png'), join(files, 'missing.png'));
    await writeFile(join(files, 'notes.txt'), 'not an image\n');
    await symlink('sunset.png', join(files, 'link.png'));
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

    await mkdir(USER_DATA, { recursive: true });
    const now = new Date().toISOString();
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

    app = await _electron.launch({
      executablePath: electronPath as unknown as string,
      args: [REPO],
      colorScheme: null,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: CONFIG_HOME,
        SFTP_CLIENT_USER_DATA: USER_DATA,
        TMPDIR: APP_TMP,
        ELECTRON_ENABLE_LOGGING: '0',
      },
    });
    page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 20_000 });
    // Native Save dialogs can't be driven under xvfb: record the request and cancel.
    await app.evaluate(({ dialog: d }) => {
      const g = globalThis as unknown as { saveRequests: string[] };
      g.saveRequests = [];
      d.showSaveDialog = (async (...args: unknown[]) => {
        const opts = args.at(-1) as { defaultPath?: string };
        g.saveRequests.push(opts.defaultPath ?? '');
        return { canceled: true, filePath: '' };
      }) as typeof d.showSaveDialog;
    });
    await page.getByTestId('profile-item').filter({ hasText: 'Images' }).click();
    await page.getByTestId('topbar').getByRole('button', { name: 'Connect', exact: true }).click();
    await waitStatus('Connected');
    await waitFolder();
  }, 120_000);

  afterAll(async () => {
    if (server) signalAll(sessionPids(), 'SIGCONT');
    app?.process().kill('SIGKILL');
    await server?.stop();
    await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
    await chmod(join(TMP, 'sftp-root', 'denied.png'), 0o644).catch(() => undefined);
    if (APP_TMP) await rm(APP_TMP, { recursive: true, force: true });
    // Chromium can create a file while the tree is being removed.
    if (!process.env.KEEP_TEST_TMP) {
      for (let i = 0; i < 5; i++) {
        try {
          await rm(TMP, { recursive: true, force: true });
          break;
        } catch (err) {
          if (i === 4 || (err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw err;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }
  });

  it('CSP: blob: images load; data: and remote images are blocked', async () => {
    const H = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const r = await page.evaluate(async (h) => {
      const load = (src: string): Promise<string> =>
        new Promise((res) => {
          const i = new Image();
          i.onload = () => res('loaded');
          i.onerror = () => res('blocked');
          i.src = src;
        });
      const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const raw = Uint8Array.from(atob(gif), (c) => c.charCodeAt(0));
      const blob = URL.createObjectURL(new Blob([raw], { type: 'image/gif' }));
      return {
        blob: await load(blob),
        data: await load(`data:image/gif;base64,${gif}`),
        remote: await load(`${h}/csp-probe.png`),
      };
    }, H);
    expect(r).toEqual({ blob: 'loaded', data: 'blocked', remote: 'blocked' });
    expect(httpHits).toEqual([]);
  });

  it('Preview button and Space: only regular image files; links and other files are not offered', async () => {
    await row('link.png').click();
    expect(await page.getByTestId('preview-button').isDisabled()).toBe(true);
    await row('notes.txt').click();
    expect(await page.getByTestId('preview-button').isDisabled()).toBe(true);
    await page.keyboard.press('Space');
    await expect
      .poll(() => page.getByTestId('browser-message').innerText())
      .toMatch(/can't be previewed/);
    expect(await dialog().count()).toBe(0);
    await row('sunset.png').click();
    expect(await page.getByTestId('preview-button').isEnabled()).toBe(true);
  });

  it.each([
    ['sunset.png', 'image/png', '800 × 500 px', '40-preview-png.png'],
    ['night.jpg', 'image/jpeg', '1200 × 800 px', '41-preview-jpeg.png'],
    ['blink.gif', 'image/gif', '320 × 200 px', null],
    ['meadow.webp', 'image/webp', '640 × 480 px', null],
    ['dusk.avif', 'image/avif', '400 × 250 px', null],
    ['tiles.bmp', 'image/bmp', '256 × 160 px', null],
    ['favicon.ico', 'image/x-icon', null, null],
  ])('previews %s (%s)', async (name, mime, dims, file) => {
    await row(name).click();
    await page.getByTestId('preview-button').click();
    await dialog().waitFor();
    await settled(name, 'ready');
    expect(await page.getByTestId('preview-image').getAttribute('data-mime')).toBe(mime);
    expect(await page.getByTestId('preview-image').getAttribute('src')).toMatch(/^blob:file:\/\//);
    if (dims) expect(await page.getByTestId('preview-meta').innerText()).toContain(dims);
    // Fit to window: never larger than the stage.
    const [img, box] = await Promise.all([
      page.getByTestId('preview-image').boundingBox(),
      stage().boundingBox(),
    ]);
    expect(img!.width).toBeLessThanOrEqual(box!.width + 0.5);
    expect(img!.height).toBeLessThanOrEqual(box!.height + 0.5);
    expect(await page.getByRole('dialog', { name }).count()).toBe(1);
    if (file) await shot(file);
    await closePreview();
  });

  it('SVG with <script>, onload, CSS @import and an external <image>: rendered, nothing runs or is fetched', async () => {
    await openPreview('evil.svg');
    await settled('evil.svg', 'ready');
    await page.waitForTimeout(1000);
    const marks = await page.evaluate(() => ({
      script: (window as unknown as { svgScriptRan?: number }).svgScriptRan ?? null,
      onload: (window as unknown as { svgOnload?: number }).svgOnload ?? null,
      title: document.title,
    }));
    expect(marks).toEqual({ script: null, onload: null, title: 'SimpleSFTP' });
    expect(await page.getByTestId('preview-meta').innerText()).toContain('600 × 360 px');
    expect(httpHits).toEqual([]);
    await shot('42-preview-svg-script-blocked.png');
    await closePreview();
  });

  it.each([
    [
      'not-an-image.png',
      'PREVIEW_UNSUPPORTED',
      /Not a supported image/,
      '43-preview-not-an-image.png',
    ],
    ['truncated.png', 'PREVIEW_CORRUPT', /Couldn't display this image/, '44-preview-damaged.png'],
    ['huge.png', 'PREVIEW_TOO_LARGE', /Too large to preview/, '45-preview-too-large.png'],
    [
      'denied.png',
      'REMOTE_PERMISSION_DENIED',
      /Permission denied/,
      '46-preview-permission-denied.png',
    ],
  ])('%s → %s error state', async (name, code, text, file) => {
    await openPreview(name);
    await settled(name, 'error');
    expect(await page.getByTestId('preview-error').getAttribute('data-code')).toBe(code);
    expect(await page.getByTestId('preview-error').innerText()).toMatch(text);
    expect(await page.getByTestId('preview-image').count()).toBe(0);
    await shot(file);
    if (code === 'PREVIEW_TOO_LARGE') {
      // The way out is Download (main's Save dialog; stubbed to cancel here).
      expect(await page.getByTestId('preview-download').getAttribute('class')).toBe('primary');
      await page.getByTestId('preview-download').click();
      await dialog().waitFor({ state: 'detached' });
      const saves = await app!.evaluate(
        () => (globalThis as unknown as { saveRequests: string[] }).saveRequests,
      );
      expect(saves.at(-1)).toMatch(/huge\.png$/);
    } else {
      await closePreview();
    }
  });

  it('a file deleted on the server after listing → File not found', async () => {
    await rm(join(TMP, 'sftp-root', 'missing.png'));
    await openPreview('missing.png');
    await settled('missing.png', 'error');
    expect(await page.getByTestId('preview-error').getAttribute('data-code')).toBe(
      'REMOTE_NOT_FOUND',
    );
    await shot('47-preview-not-found.png');
    await closePreview();
  });

  it('Prev/Next with arrow keys walk the folder images; Esc closes, restores focus and selects the last image', async () => {
    await openPreview('night.jpg');
    await settled('night.jpg', 'ready');
    expect(await page.getByTestId('preview-meta').innerText()).toContain(
      `${IMAGE_ORDER.indexOf('night.jpg') + 1} of ${IMAGE_ORDER.length}`,
    );
    await page.keyboard.press('ArrowRight');
    await settled('not-an-image.png', 'error');
    await page.keyboard.press('ArrowRight');
    await settled('sunset.png', 'ready');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await settled('night.jpg', 'ready');
    // Backspace / Alt+Up inside the preview must not navigate the folder underneath.
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Alt+ArrowUp');
    expect(await dialog().count()).toBe(1);
    await page.getByRole('button', { name: 'Next image' }).click();
    await settled('not-an-image.png', 'error');
    await closePreview();
    await waitFolder();
    const focus = await page.evaluate(() => ({
      inTable: !!document.activeElement?.closest('[data-testid="file-table"], [role="grid"]'),
      tag: document.activeElement?.tagName,
    }));
    expect(focus.inTable).toBe(true);
    expect(
      await page
        .locator('[data-testid="file-row"][aria-selected="true"]')
        .getAttribute('data-name'),
    ).toBe('not-an-image.png');
    // First and last images: Prev / Next are disabled.
    await openPreview('blink.gif');
    expect(await page.getByRole('button', { name: 'Previous image' }).isDisabled()).toBe(true);
    await closePreview();
  });

  it('double-click still downloads (no preview)', async () => {
    const before = (
      await app!.evaluate(() => (globalThis as unknown as { saveRequests: string[] }).saveRequests)
    ).length;
    await row('sunset.png').dblclick();
    await expect
      .poll(
        async () =>
          (
            await app!.evaluate(
              () => (globalThis as unknown as { saveRequests: string[] }).saveRequests,
            )
          ).length,
      )
      .toBe(before + 1);
    expect(await dialog().count()).toBe(0);
  });

  it('rapid Next on a frozen server: only the last selection is ever shown', async () => {
    await openPreview('blink.gif');
    await settled('blink.gif', 'ready');
    // Record every image that appears from now on.
    await page.evaluate(() => {
      const g = window as unknown as { previewShown: string[] };
      g.previewShown = [];
      new MutationObserver(() => {
        const s = document.querySelector('[data-testid="preview-stage"]');
        if (s?.querySelector('img')) g.previewShown.push(s.getAttribute('data-name') ?? '');
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    const frozen = sessionPids();
    signalAll(frozen, 'SIGSTOP');
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    const want = IMAGE_ORDER[6]!; // marked.png
    await page.getByTestId('preview-stage').getByRole('status').waitFor();
    await shot('48-preview-loading.png');
    signalAll(frozen, 'SIGCONT');
    await settled(want, 'ready');
    await page.waitForTimeout(500);
    const shown = await page.evaluate(
      () => (window as unknown as { previewShown: string[] }).previewShown,
    );
    expect(new Set(shown)).toEqual(new Set([want]));
    await closePreview();
  });

  it('disconnect mid-preview: the preview closes cleanly and the app shows the lost connection', async () => {
    const frozen = sessionPids();
    signalAll(frozen, 'SIGSTOP');
    await openPreview('night.jpg');
    await page.getByTestId('preview-stage').getByRole('status').waitFor();
    signalAll(frozen, 'SIGKILL');
    await page.getByTestId('browser-state-disconnected').waitFor({ timeout: 15_000 });
    expect(await dialog().count()).toBe(0);
    await shot('49-preview-disconnected.png');
    // Reconnect and preview again works.
    await page
      .getByTestId('browser-state-disconnected')
      .getByRole('button', { name: 'Reconnect' })
      .click();
    await waitStatus('Connected');
    await waitFolder();
    await openPreview('sunset.png');
    await settled('sunset.png', 'ready');
    await closePreview();
  });

  it('nothing is written to local disk: no image bytes or markers in app data or temp', async () => {
    // Previewed marked.png (in the rapid test) and evil.svg, both carry MARKER.
    const files = [...(await walk(CONFIG_HOME)), ...(await walk(APP_TMP))];
    // The app's own data and Chromium's storage are there: the scan is not empty.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('profiles.json'))).toBe(true);
    const needle = Buffer.from(MARKER);
    const sunsetBody = (await readFile(join(IMAGES, 'sunset.png'))).subarray(200, 264);
    const hits: string[] = [];
    for (const f of files) {
      const b = await readFile(f).catch(() => Buffer.alloc(0));
      if (b.includes(needle) || b.includes(sunsetBody)) hits.push(f);
    }
    expect(hits).toEqual([]);
    expect(files.filter((f) => /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(f))).toEqual([]);
    expect(httpHits).toEqual([]);
  });
});
