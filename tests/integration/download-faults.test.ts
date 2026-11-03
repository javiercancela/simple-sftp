// Fault cases needing special servers or a special filesystem (A11):
// SFTP unavailable at connect, the SFTP subsystem dying mid-transfer, and a
// full disk (a size-limited tmpfs in an unprivileged user+mount namespace;
// the transfer is real, the disk really fills up).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DownloadService } from '../../src/main/downloads/download-service';
import { TransferJournal } from '../../src/main/downloads/journal';
import type { DownloadsSnapshot } from '../../src/shared/downloads';
import { startFixtureServer, signalAll, type FixtureServer } from './helpers/fixture-server';
import { hostFingerprint } from './helpers/keys';
import { findSshd } from './helpers/sshd';

const bin = findSshd();
const ROOT = resolve(__dirname, '..', '.tmp', `faults-${process.pid}-${Date.now()}`);
const FILES = join(ROOT, 'files');
const MiB = 1024 ** 2;
const REPO = resolve(__dirname, '..', '..');

const canUnshare =
  process.platform === 'linux' &&
  spawnSync('unshare', ['-Urm', 'true'], { stdio: 'ignore' }).status === 0;

async function randomFile(p: string, size: number): Promise<void> {
  const fh = await open(p, 'w');
  for (let off = 0; off < size; off += 4 * MiB)
    await fh.write(randomBytes(Math.min(4 * MiB, size - off)));
  await fh.close();
}

function service(
  fx: FixtureServer,
  dest: string,
  journal: TransferJournal,
): {
  svc: DownloadService;
  waitFor: (p: (s: DownloadsSnapshot) => boolean, ms?: number) => Promise<DownloadsSnapshot>;
} {
  const waiters = new Set<() => void>();
  const svc = new DownloadService({
    connection: () => {
      const s = fx.snapshot();
      return {
        sessionId: s.sessionId,
        profileId: s.profileId,
        profileName: s.profileName,
        connected: s.state === 'connected',
      };
    },
    getSession: (id) => fx.mgr.getSession(id),
    getProfile: () => fx.profile,
    saveDialog: (def) => Promise.resolve(join(dest, def.split('/').pop()!)),
    chooseDirectory: () => Promise.resolve(dest),
    defaultDownloadDir: () => dest,
    journal,
    platform: 'linux',
    emit: () => {
      for (const w of waiters) w();
    },
    reveal: () => undefined,
    progressIntervalMs: 50,
  });
  const waitFor = (
    pred: (s: DownloadsSnapshot) => boolean,
    ms = 30_000,
  ): Promise<DownloadsSnapshot> =>
    new Promise((res, rej) => {
      const check = (): void => {
        const s = svc.getSnapshot();
        if (pred(s)) {
          waiters.delete(check);
          clearTimeout(t);
          res(s);
        }
      };
      const t = setTimeout(() => {
        waiters.delete(check);
        rej(
          new Error(
            `timeout: ${JSON.stringify(svc.getSnapshot().jobs.map((j) => [j.state, j.error]))}`,
          ),
        );
      }, ms);
      waiters.add(check);
      check();
    });
  return { svc, waitFor };
}

describe.skipIf(!bin)('download fault cases (real sshd, real filesystem)', () => {
  const servers: FixtureServer[] = [];
  beforeAll(async () => {
    await mkdir(FILES, { recursive: true });
    await randomFile(join(FILES, 'big.bin'), 64 * MiB);
    await randomFile(join(FILES, 'small.bin'), MiB);
  }, 60_000);
  afterAll(async () => {
    for (const s of servers) await s.stop().catch(() => undefined);
    if (!process.env.KEEP_TEST_TMP) await rm(ROOT, { recursive: true, force: true });
  });

  it('SFTP unavailable: a server without the SFTP subsystem fails to connect with SFTP_UNAVAILABLE', async () => {
    const fx = await startFixtureServer({
      bin: bin!,
      root: join(ROOT, 'nosftp'),
      sftpRoot: FILES,
      sftpServer: 'none',
    });
    servers.push(fx);
    await expect(fx.connect()).rejects.toThrow(/SFTP_UNAVAILABLE/);
    expect(fx.snapshot().error?.code).toBe('SFTP_UNAVAILABLE');
  });

  it('SFTP subsystem stops mid-transfer: the job fails as SFTP unavailable, the queue pauses, the partial is removed', async (ctx) => {
    if (!bin!.sftpServer) {
      ctx.skip(
        'sftp-server binary not found (libexec, common OS paths, and sshd -T subsystem). The mid-transfer kill needs an external sftp-server; internal-sftp cannot be signalled on its own.',
      );
    }
    const fx = await startFixtureServer({
      bin: bin!,
      root: join(ROOT, 'ext'),
      sftpRoot: FILES,
      sftpServer: 'external',
    });
    servers.push(fx);
    const sessionId = await fx.connect();
    const dest = join(ROOT, 'dest-ext');
    await mkdir(dest);
    const journal = new TransferJournal(join(ROOT, 'state-ext'));
    await mkdir(join(ROOT, 'state-ext'));
    await journal.load();
    const { svc, waitFor } = service(fx, dest, journal);
    const r = await svc.chooseDestinationAndEnqueue(sessionId, [
      join(FILES, 'big.bin'),
      join(FILES, 'small.bin'),
    ]);
    if (r.status !== 'enqueued') throw new Error(r.status);
    await waitFor((s) => (s.jobs[0]?.bytes ?? 0) > 0);
    const sftp = fx.sftpServerPids();
    expect(
      sftp,
      `expected one sftp-server process; session commands: ${fx.sessionCommands().join(' | ') || '(none)'}`,
    ).toHaveLength(1);
    signalAll(sftp, 'SIGKILL');
    const s = await waitFor((x) => x.jobs[0]?.state === 'failed' && x.pause !== null);
    expect(s.jobs[0]!.error?.code).toBe('SFTP_UNAVAILABLE');
    expect(s.jobs[1]!.state).toBe('queued');
    expect(await readdir(dest)).toEqual([]);
    expect(journal.list()).toEqual([]);
    // The connection is reported as ended, with the same reason.
    await new Promise((res) => setTimeout(res, 500));
    expect(fx.snapshot().state).toBe('disconnected');
    expect(fx.snapshot().error?.code).toBe('SFTP_UNAVAILABLE');
    await svc.cancelAll();
  });

  it.skipIf(!canUnshare)(
    'disk full: the job fails as DISK_FULL and leaves nothing behind',
    async () => {
      const fx = await startFixtureServer({ bin: bin!, root: join(ROOT, 'disk'), sftpRoot: FILES });
      servers.push(fx);
      const dl = join(ROOT, 'small-disk');
      await mkdir(dl);
      await mkdir(join(ROOT, 'state-disk'));
      // The client side runs in its own user+mount namespace where `dl` is an
      // 8 MiB tmpfs. It connects to the same 127.0.0.1 sshd as everything else.
      const env = {
        ...process.env,
        SFTP_INNER_DISKFULL: '1',
        INNER_PORT: String(fx.server.cfg.port),
        INNER_USER: userInfo().username,
        INNER_KEY: fx.profile.privateKeyPath,
        INNER_CERT: fx.profile.certificatePath ?? '',
        INNER_HOST_FP: hostFingerprint(join(ROOT, 'disk', 'keys', 'host.pub')),
        INNER_REMOTE: join(FILES, 'big.bin'),
        INNER_DL: dl,
        INNER_STATE: join(ROOT, 'state-disk'),
      };
      const inner = spawnSync(
        'unshare',
        [
          '-Urm',
          'sh',
          '-c',
          'mount -t tmpfs -o size=8m tmpfs "$INNER_DL" && exec npx vitest run tests/integration/inner/disk-full.inner.test.ts --reporter=verbose',
        ],
        { cwd: REPO, env, encoding: 'utf8', timeout: 120_000 },
      );
      const out = `${inner.stdout}\n${inner.stderr}`;
      expect(out, out).toMatch(/✓ .*disk full/);
      expect(inner.status, out).toBe(0);
      const line = /\[disk-full\] (.*)/.exec(out)?.[1];
      expect(line).toBeTruthy();
      await writeFile(
        join(REPO, 'docs', 'download-diskfull.json'),
        `${JSON.stringify({ measuredAt: new Date().toISOString(), method: 'unprivileged user+mount namespace (unshare -Urm) with an 8 MiB tmpfs mounted over the download folder; real ENOSPC from the kernel', result: line }, null, 2)}\n`,
      );
      // Outside the namespace the folder was never written to.
      await writeFile(join(dl, 'probe'), 'x');
      expect(await readdir(dl)).toEqual(['probe']);
    },
    180_000,
  );
});
