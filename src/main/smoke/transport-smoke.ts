// Packaged transport smoke test: proves the bundled SSH/SFTP transport works
// inside the packaged app (not just under Node in dev). Driven by
// tests/smoke/packaged-smoke.test.ts through SFTP_CLIENT_TRANSPORT_SMOKE.
import type { BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { loadCredentials } from '../connections/credentials';
import { isTransportError } from '../connections/errors';
import { connect } from '../connections/transport';

const SmokeLoginSchema = z.object({
  label: z.string(),
  privateKeyPath: z.string(),
  certificatePath: z.string().optional(),
  expect: z.enum(['success', 'AUTH_REJECTED']),
});

const SmokeConfigSchema = z.object({
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  expectedHostFingerprint: z.string(),
  remoteFile: z.string(),
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  outputDir: z.string(),
  resultPath: z.string(),
  logins: z.array(SmokeLoginSchema).min(1),
});

interface StepResult {
  label: string;
  ok: boolean;
  detail: string;
}

export async function runTransportSmoke(configPath: string, win: BrowserWindow): Promise<number> {
  const steps: StepResult[] = [];
  let resultPath: string | undefined;
  try {
    const cfg = SmokeConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
    resultPath = cfg.resultPath;

    // Renderer actually loaded inside the packaged app.
    await new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) resolve();
      else win.webContents.once('did-finish-load', () => resolve());
    });
    // React mounts after did-finish-load; wait for the app shell to render.
    let title = '';
    for (let i = 0; i < 50 && !title; i++) {
      title = String(
        await win.webContents.executeJavaScript(
          'document.querySelector(".app [data-testid=active-server]")?.textContent ?? ""',
        ),
      );
      if (!title) await new Promise((r) => setTimeout(r, 200));
    }
    steps.push({
      label: 'renderer-loaded',
      ok: title !== '',
      detail: `active-server=${title}`,
    });

    for (const login of cfg.logins) {
      try {
        const creds = await loadCredentials({
          privateKeyPath: login.privateKeyPath,
          ...(login.certificatePath ? { certificatePath: login.certificatePath } : {}),
        });
        const session = await connect({
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          credentials: creds,
          verifyHost: async (info) => info.fingerprintSha256 === cfg.expectedHostFingerprint,
          timeoutMs: 15_000,
        });
        if (login.expect !== 'success') {
          await session.disconnect();
          steps.push({ label: login.label, ok: false, detail: 'unexpectedly authenticated' });
          continue;
        }
        const home = await session.realpath('.');
        const names = (await session.list(home)).map((e) => e.name);
        const remote = path.posix.join(home, cfg.remoteFile);
        const out = path.join(cfg.outputDir, `${login.label}-${cfg.remoteFile}`);
        const hash = createHash('sha256');
        const tap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        await pipeline(
          session.createReadStream(remote),
          tap,
          createWriteStream(out, { flags: 'wx' }),
        );
        const digest = hash.digest('hex');
        await session.disconnect();
        steps.push({
          label: login.label,
          ok: names.includes(cfg.remoteFile) && digest === cfg.expectedSha256,
          detail: `listed ${names.length} entries; sha256 ${digest}`,
        });
      } catch (err) {
        const code = isTransportError(err) ? err.code : 'UNEXPECTED';
        steps.push({
          label: login.label,
          ok: login.expect === code,
          detail: `${code}: ${(err as Error).message}`,
        });
      }
    }
  } catch (err) {
    steps.push({ label: 'smoke-setup', ok: false, detail: (err as Error).message });
  }
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  const result = {
    ok,
    steps,
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    appPath: process.execPath,
    // Proves the code ran from the packaged asar, not the dev tree.
    mainScript: __filename,
  };
  if (resultPath) await writeFile(resultPath, JSON.stringify(result, null, 2));
  else process.stdout.write(JSON.stringify(result) + '\n');
  return ok ? 0 : 1;
}
