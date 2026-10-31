// DownloadService against a real OpenSSH server on 127.0.0.1 and the real
// local filesystem (spec 7, A8-A12). No SSH or filesystem mocks: the only
// injected pieces are the native dialogs' return values and, for a few
// cases, a hook that makes a real filesystem change right before
// finalization.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DownloadService, type DownloadDeps } from '../../src/main/downloads/download-service';
import { TransferJournal } from '../../src/main/downloads/journal';
import type { DownloadJobView, DownloadsSnapshot, EnqueueResult } from '../../src/shared/downloads';
import { startFixtureServer, signalAll, type FixtureServer } from './helpers/fixture-server';
import { findSshd } from './helpers/sshd';

const bin = findSshd();
const ROOT = resolve(__dirname, '..', '.tmp', `downloads-${process.pid}-${Date.now()}`);
const FILES = join(ROOT, 'files');
const DEST = join(ROOT, 'dest');
const OUTSIDE = join(ROOT, 'outside');
const R = (n: string): string => join(FILES, n);
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const HUGE_SIZE = 4 * GiB + 5 * MiB;

let fx: FixtureServer;
let sessionId = '';
const metrics: Record<string, string> = {};

async function sha256(p: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(p, { highWaterMark: 4 * MiB }))
    h.update(chunk as Buffer);
  return h.digest('hex');
}

async function randomFile(p: string, size: number): Promise<void> {
  const fh = await open(p, 'w');
  for (let off = 0; off < size; off += 4 * MiB)
    await fh.write(randomBytes(Math.min(4 * MiB, size - off)));
  await fh.close();
}

interface Harness {
  svc: DownloadService;
  journal: TransferJournal;
  snaps: DownloadsSnapshot[];
  last(): DownloadsSnapshot;
  job(id: string): DownloadJobView;
  waitFor(pred: (s: DownloadsSnapshot) => boolean, ms?: number): Promise<DownloadsSnapshot>;
  next: { save: string | null; dir: string | null };
  revealed: string[];
  hooks: { beforeFinalize?: ((jobId: string) => Promise<void>) | undefined };
}

async function harness(opts: { platform?: string; stateDir?: string } = {}): Promise<Harness> {
  const stateDir = opts.stateDir ?? join(ROOT, 'state', String(Math.random()).slice(2));
  await mkdir(stateDir, { recursive: true });
  const journal = new TransferJournal(stateDir);
  await journal.load();
  const snaps: DownloadsSnapshot[] = [];
  const waiters = new Set<() => void>();
  const next: Harness['next'] = { save: null, dir: null };
  const revealed: string[] = [];
  const hooks: Harness['hooks'] = {};
  const deps: DownloadDeps = {
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
    getProfile: (id) => (id === fx.profile.id ? fx.profile : undefined),
    // Native dialogs: the Save dialog accepts the proposed name in next.dir
    // unless a full path is given.
    saveDialog: (def) =>
      Promise.resolve(next.save ?? (next.dir ? join(next.dir, basename(def)) : null)),
    chooseDirectory: () => Promise.resolve(next.dir),
    defaultDownloadDir: () => DEST,
    journal,
    platform: opts.platform ?? 'linux',
    emit: (s) => {
      snaps.push(s);
      for (const w of waiters) w();
    },
    reveal: (p) => revealed.push(p),
    progressIntervalMs: 50,
    beforeFinalize: (id) => hooks.beforeFinalize?.(id) ?? Promise.resolve(),
  };
  const svc = new DownloadService(deps);
  const last = (): DownloadsSnapshot => svc.getSnapshot();
  return {
    svc,
    journal,
    snaps,
    last,
    job: (id) => {
      const j = last().jobs.find((x) => x.id === id);
      if (!j) throw new Error(`no job ${id}`);
      return j;
    },
    waitFor: (pred, ms = 60_000) =>
      new Promise((res, rej) => {
        const check = (): void => {
          const s = last();
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
              `timeout; last: ${JSON.stringify(last().jobs.map((j) => [j.fileName, j.state, j.error?.code]))}`,
            ),
          );
        }, ms);
        waiters.add(check);
        check();
      }),
    next,
    revealed,
    hooks,
  };
}

const enqueued = (r: EnqueueResult): string[] => {
  if (r.status !== 'enqueued') throw new Error(`expected enqueued, got ${JSON.stringify(r)}`);
  return r.jobIds;
};
const terminal = (h: Harness, id: string) => (s: DownloadsSnapshot) =>
  ['completed', 'failed', 'cancelled'].includes(s.jobs.find((j) => j.id === id)?.state ?? '');

async function freshDest(name: string): Promise<string> {
  const d = join(DEST, name);
  await mkdir(d, { recursive: true });
  return d;
}

const listDir = async (d: string): Promise<string[]> => (await readdir(d)).sort();

describe.skipIf(!bin)('DownloadService against real sshd and the real filesystem', () => {
  const hashes: Record<string, string> = {};

  beforeAll(async () => {
    await mkdir(FILES, { recursive: true });
    await mkdir(DEST, { recursive: true });
    await mkdir(OUTSIDE, { recursive: true });
    await writeFile(R('zero.bin'), '');
    await randomFile(R('ordinary.bin'), 3 * MiB + 17);
    await randomFile(R('medium.bin'), 96 * MiB);
    for (const n of ['q1', 'q2', 'q3', 'q4', 'q5']) await randomFile(R(`${n}.bin`), 48 * MiB);
    await writeFile(R('secret.bin'), 'no read access');
    await chmod(R('secret.bin'), 0o000);
    await writeFile(R('..\\..\\evil.txt'), 'backslash name');
    await writeFile(R('line\nbreak.txt'), 'newline name');
    await writeFile(R('CON.txt'), 'reserved on windows');
    await writeFile(R('Readme.txt'), 'upper');
    await writeFile(R('README.txt'), 'caps');
    await symlink('ordinary.bin', R('link.bin'));
    // > 4 GiB sparse file with random data at the start, across the 4 GiB
    // boundary and at the end, so offsets above 2^32 are really checked.
    const fh = await open(R('huge.bin'), 'w');
    await fh.truncate(HUGE_SIZE);
    await fh.write(randomBytes(MiB), 0, MiB, 0);
    await fh.write(randomBytes(MiB), 0, MiB, 4 * GiB - MiB / 2);
    await fh.write(randomBytes(MiB), 0, MiB, HUGE_SIZE - MiB);
    await fh.close();
    for (const n of ['zero.bin', 'ordinary.bin', 'medium.bin', 'q1.bin', 'huge.bin'])
      hashes[n] = await sha256(R(n));
    fx = await startFixtureServer({ bin: bin!, root: join(ROOT, 'srv'), sftpRoot: FILES });
    sessionId = await fx.connect();
  }, 300_000);

  afterAll(async () => {
    await fx?.stop();
    await chmod(R('secret.bin'), 0o644).catch(() => undefined);
    // Vitest hides console output of passing tests, so keep the numbers in a file.
    if (Object.keys(metrics).length)
      await writeFile(
        resolve(__dirname, '..', '..', 'docs', 'download-metrics.json'),
        `${JSON.stringify({ measuredAt: new Date().toISOString(), environment: 'Linux, DownloadService in Node against OpenSSH 10.0p2 sshd on 127.0.0.1', ...metrics }, null, 2)}\n`,
      );
    if (!process.env.KEEP_TEST_TMP) await rm(ROOT, { recursive: true, force: true });
  });

  it('A8: zero-byte and ordinary files download with matching SHA-256; no partial left', async () => {
    const h = await harness();
    const dir = await freshDest('a8');
    h.next.dir = dir;
    const ids = enqueued(
      await h.svc.chooseDestinationAndEnqueue(sessionId, [R('zero.bin'), R('ordinary.bin')]),
    );
    expect(ids).toHaveLength(2);
    await h.waitFor((s) =>
      ids.every((id) => s.jobs.find((j) => j.id === id)?.state === 'completed'),
    );
    expect(await listDir(dir)).toEqual(['ordinary.bin', 'zero.bin']);
    expect(await sha256(join(dir, 'zero.bin'))).toBe(hashes['zero.bin']);
    expect(await sha256(join(dir, 'ordinary.bin'))).toBe(hashes['ordinary.bin']);
    metrics.zeroSha256 = hashes['zero.bin']!;
    metrics.ordinarySha256 = hashes['ordinary.bin']!;
    expect(h.job(ids[0]!).bytes).toBe(0);
    expect(h.job(ids[0]!).total).toBe(0);
    expect(h.job(ids[1]!).bytes).toBe(3 * MiB + 17);
    expect(h.journal.list()).toEqual([]);
    // Show in folder only for completed jobs.
    h.svc.reveal(ids[1]!);
    expect(h.revealed).toEqual([join(dir, 'ordinary.bin')]);
  });

  it('single file: the Save dialog path decides folder and name', async () => {
    const h = await harness();
    const dir = await freshDest('single');
    h.next.save = join(dir, 'renamed copy.bin');
    const [id] = enqueued(await h.svc.chooseDestinationAndEnqueue(sessionId, [R('ordinary.bin')]));
    await h.waitFor(terminal(h, id!));
    expect(h.job(id!).state).toBe('completed');
    expect(h.job(id!).finalPath).toBe(join(dir, 'renamed copy.bin'));
    expect(await sha256(join(dir, 'renamed copy.bin'))).toBe(hashes['ordinary.bin']);
    // Cancelling the dialog queues nothing.
    h.next.save = null;
    expect(await h.svc.chooseDestinationAndEnqueue(sessionId, [R('ordinary.bin')])).toEqual({
      status: 'canceled',
    });
  });

  it('A8: a file larger than 4 GiB downloads intact with bounded memory', async () => {
    const h = await harness();
    const dir = await freshDest('huge');
    h.next.dir = dir;
    global.gc?.();
    const base = process.memoryUsage().rss;
    let peak = base;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 100);
    const t0 = Date.now();
    const [id] = enqueued(await h.svc.chooseDestinationAndEnqueue(sessionId, [R('huge.bin')]));
    await h.waitFor(terminal(h, id!), 600_000);
    const secs = (Date.now() - t0) / 1000;
    clearInterval(sampler);
    const j = h.job(id!);
    expect(j.error).toBeNull();
    expect(j.state).toBe('completed');
    expect(j.total).toBe(HUGE_SIZE);
    expect(j.bytes).toBe(HUGE_SIZE); // no 32-bit truncation
    expect((await lstat(join(dir, 'huge.bin'))).size).toBe(HUGE_SIZE);
    const hugeLocal = await sha256(join(dir, 'huge.bin'));
    expect(hugeLocal).toBe(hashes['huge.bin']);
    metrics.hugeSha256 = `local ${hugeLocal} = remote ${hashes['huge.bin']}`;
    const delta = (peak - base) / MiB;
    metrics.huge = `${(HUGE_SIZE / GiB).toFixed(3)} GiB in ${secs.toFixed(1)} s (${(HUGE_SIZE / MiB / secs).toFixed(0)} MiB/s); RSS baseline ${(base / MiB).toFixed(0)} MiB, peak ${(peak / MiB).toFixed(0)} MiB (+${delta.toFixed(0)} MiB)`;
    expect(delta).toBeLessThan(256);
    await rm(join(dir, 'huge.bin'));
  }, 900_000);

  it('A9: one active transfer; cancel active and queued; retry starts from zero', async () => {
    const h = await harness();
    const dir = await freshDest('queue');
    h.next.dir = dir;
    const names = ['q1.bin', 'q2.bin', 'q3.bin', 'q4.bin', 'q5.bin'];
    let maxActive = 0;
    const ids = enqueued(await h.svc.chooseDestinationAndEnqueue(sessionId, names.map(R)));
    const watch = setInterval(() => {
      maxActive = Math.max(
        maxActive,
        h.last().jobs.filter((j) => j.state === 'downloading').length,
      );
    }, 5);
    // Cancel the active one once bytes flow, and a queued one.
    await h.waitFor((s) => (s.jobs.find((j) => j.id === ids[0])?.bytes ?? 0) > 0);
    h.svc.cancel(ids[0]!);
    h.svc.cancel(ids[3]!);
    expect(h.job(ids[3]!).state).toBe('cancelled');
    await h.waitFor((s) => ids.every((id) => terminal(h, id)(s)), 120_000);
    clearInterval(watch);
    for (const s of h.snaps)
      expect(s.jobs.filter((j) => j.state === 'downloading').length).toBeLessThanOrEqual(1);
    expect(maxActive).toBe(1);
    expect(ids.map((id) => h.job(id).state)).toEqual([
      'cancelled',
      'completed',
      'completed',
      'cancelled',
      'completed',
    ]);
    expect(await listDir(dir)).toEqual(['q2.bin', 'q3.bin', 'q5.bin']); // no partials
    // Terminal states are immutable.
    expect(() => h.svc.cancel(ids[1]!)).toThrow(/already finished/);
    expect(h.job(ids[1]!).state).toBe('completed');
    // Retry: a new job from byte zero.
    const before = h.snaps.length;
    const rid = h.svc.retry(ids[0]!);
    expect(rid).not.toBe(ids[0]);
    await h.waitFor(terminal(h, rid));
    const firstSeen = h.snaps
      .slice(before)
      .map((s) => s.jobs.find((j) => j.id === rid))
      .find((j) => j?.state === 'downloading');
    expect(firstSeen?.bytes).toBe(0);
    expect(h.job(rid).retryOf).toBe(ids[0]);
    expect(await sha256(join(dir, 'q1.bin'))).toBe(hashes['q1.bin']);
    expect(h.last().jobs.some((j) => j.id === ids[0])).toBe(false);
  }, 180_000);

  it('A10: collisions offer Replace, Keep both, Skip and rename; nothing is overwritten silently', async () => {
    const h = await harness();
    const dir = await freshDest('collide');
    h.next.dir = dir;
    for (const n of ['zero.bin', 'ordinary.bin', 'q1.bin', 'q2.bin'])
      await writeFile(join(dir, n), `OLD ${n}`);
    const r = await h.svc.chooseDestinationAndEnqueue(
      sessionId,
      ['zero.bin', 'ordinary.bin', 'q1.bin', 'q2.bin'].map(R),
    );
    if (r.status !== 'needsDecision') throw new Error(r.status);
    expect(r.items.map((i) => [i.localName, i.issue, i.choices.join('/')])).toEqual([
      ['zero.bin', 'exists', 'replace/keepBoth/rename/skip'],
      ['ordinary.bin', 'exists', 'replace/keepBoth/rename/skip'],
      ['q1.bin', 'exists', 'replace/keepBoth/rename/skip'],
      ['q2.bin', 'exists', 'replace/keepBoth/rename/skip'],
    ]);
    const id = (n: string): string => r.items.find((i) => i.localName === n)!.itemId;
    // Missing decision is rejected.
    await expect(
      h.svc.resolvePlan(r.planId, [{ itemId: id('zero.bin'), action: 'skip' }]),
    ).rejects.toThrow(/every file/);
    const done = await h.svc.resolvePlan(r.planId, [
      { itemId: id('zero.bin'), action: 'skip' },
      { itemId: id('ordinary.bin'), action: 'replace' },
      { itemId: id('q1.bin'), action: 'keepBoth' },
      { itemId: id('q2.bin'), action: 'rename', name: 'q2 renamed.bin' },
    ]);
    const ids = enqueued(done);
    expect(ids).toHaveLength(3);
    await h.waitFor((s) => ids.every((x) => terminal(h, x)(s)));
    expect(await listDir(dir)).toEqual([
      'ordinary.bin',
      'q1 (1).bin',
      'q1.bin',
      'q2 renamed.bin',
      'q2.bin',
      'zero.bin',
    ]);
    expect(await readFile(join(dir, 'zero.bin'), 'utf8')).toBe('OLD zero.bin');
    expect(await sha256(join(dir, 'ordinary.bin'))).toBe(hashes['ordinary.bin']);
    expect(await readFile(join(dir, 'q1.bin'), 'utf8')).toBe('OLD q1.bin');
    expect(await sha256(join(dir, 'q1 (1).bin'))).toBe(hashes['q1.bin']);
    expect(await readFile(join(dir, 'q2.bin'), 'utf8')).toBe('OLD q2.bin');
    // A stale plan id is rejected.
    await expect(h.svc.resolvePlan(r.planId, [])).rejects.toThrow(/no longer current/);
  }, 120_000);

  it('A10: Keep both picks a free number even when names are taken concurrently', async () => {
    const h = await harness();
    const dir = await freshDest('keepboth-race');
    h.next.dir = dir;
    await writeFile(join(dir, 'ordinary.bin'), 'OLD');
    const r = await h.svc.chooseDestinationAndEnqueue(sessionId, [R('ordinary.bin')]);
    if (r.status !== 'needsDecision') throw new Error(r.status);
    // Another program creates the next numbered names right before finalization.
    h.hooks.beforeFinalize = async () => {
      await writeFile(join(dir, 'ordinary (1).bin'), 'RACE 1');
      await writeFile(join(dir, 'ordinary (2).bin'), 'RACE 2');
    };
    const ids = enqueued(
      await h.svc.resolvePlan(r.planId, [{ itemId: r.items[0]!.itemId, action: 'keepBoth' }]),
    );
    await h.waitFor(terminal(h, ids[0]!));
    h.hooks.beforeFinalize = undefined;
    expect(h.job(ids[0]!).finalPath).toBe(join(dir, 'ordinary (3).bin'));
    expect(await readFile(join(dir, 'ordinary (1).bin'), 'utf8')).toBe('RACE 1');
    expect(await readFile(join(dir, 'ordinary (2).bin'), 'utf8')).toBe('RACE 2');
    expect(await readFile(join(dir, 'ordinary.bin'), 'utf8')).toBe('OLD');
    expect(await sha256(join(dir, 'ordinary (3).bin'))).toBe(hashes['ordinary.bin']);
  });

  it('A10: destination changed between approval and finalization asks again', async () => {
    const h = await harness();
    const dir = await freshDest('changed');
    h.next.dir = dir;
    // (1) New file expected, but someone created it meanwhile.
    h.hooks.beforeFinalize = async () => writeFile(join(dir, 'ordinary.bin'), 'APPEARED');
    const [a] = enqueued(await h.svc.chooseDestinationAndEnqueue(sessionId, [R('ordinary.bin')]));
    const s1 = await h.waitFor((s) => s.conflict?.jobId === a);
    h.hooks.beforeFinalize = undefined;
    expect(s1.conflict!.choices).toEqual(['replace', 'keepBoth', 'skip']);
    expect(h.job(a!).state).toBe('downloading');
    expect(() => h.svc.resolveConflict(a!, 'not-the-prompt', 'replace')).toThrow(
      /no longer current/,
    );
    h.svc.resolveConflict(a!, s1.conflict!.promptId, 'keepBoth');
    await h.waitFor(terminal(h, a!));
    expect(await readFile(join(dir, 'ordinary.bin'), 'utf8')).toBe('APPEARED');
    expect(await sha256(join(dir, 'ordinary (1).bin'))).toBe(hashes['ordinary.bin']);
    await h.waitFor((s) => s.jobs.every((j) => j.state !== 'queued' && j.state !== 'downloading'));

    // (2) Approved replacement changed before finalization: ask again; Skip keeps it.
    const r = await h.svc.chooseDestinationAndEnqueue(sessionId, [R('ordinary.bin')]);
    if (r.status !== 'needsDecision') throw new Error(r.status);
    h.hooks.beforeFinalize = async (jobId) => {
      if (h.job(jobId).fileName === 'ordinary.bin')
        await writeFile(join(dir, 'ordinary.bin'), 'EDITED MEANWHILE');
    };
    const ids = enqueued(
      await h.svc.resolvePlan(r.planId, [{ itemId: r.items[0]!.itemId, action: 'replace' }]),
    );
    const s2 = await h.waitFor((s) => s.conflict?.jobId === ids[0]);
    h.svc.resolveConflict(ids[0]!, s2.conflict!.promptId, 'skip');
    await h.waitFor((s) => ids.every((x) => terminal(h, x)(s)));
    h.hooks.beforeFinalize = undefined;
    expect(h.job(ids[0]!).state).toBe('cancelled');
    expect(await readFile(join(dir, 'ordinary.bin'), 'utf8')).toBe('EDITED MEANWHILE');
    expect((await listDir(dir)).filter((n) => n.endsWith('.part'))).toEqual([]);

    // (3) The approved folder itself was swapped for a symlink to elsewhere.
    const swap = await freshDest('swapme');
    h.next.dir = swap;
    h.hooks.beforeFinalize = async () => {
      await rename(swap, `${swap}.moved`);
      await symlink(OUTSIDE, swap);
    };
    const [c] = enqueued(await h.svc.chooseDestinationAndEnqueue(sessionId, [R('ordinary.bin')]));
    await h.waitFor(terminal(h, c!));
    h.hooks.beforeFinalize = undefined;
    expect(h.job(c!).error?.code).toBe('DESTINATION_CHANGED');
    expect(await listDir(OUTSIDE)).toEqual([]); // nothing written through the swapped-in link
    // Known limit: the closed partial moved away with the original folder; it
    // stays there (inside the folder the user approved) and is not deleted.
    expect((await listDir(`${swap}.moved`)).every((n) => n.endsWith('.part'))).toBe(true);
    await h.waitFor((s) => s.jobs.every((j) => j.state !== 'queued' && j.state !== 'downloading'));
  }, 120_000);

  it('A10: cancelled or failed replacements keep the existing file', async () => {
    const h = await harness();
    const dir = await freshDest('preserve');
    h.next.dir = dir;
    await writeFile(join(dir, 'medium.bin'), 'PRECIOUS');
    await writeFile(join(dir, 'secret.bin'), 'PRECIOUS TOO');
    const r = await h.svc.chooseDestinationAndEnqueue(sessionId, [
      R('medium.bin'),
      R('secret.bin'),
    ]);
    if (r.status !== 'needsDecision') throw new Error(r.status);
    const ids = enqueued(
      await h.svc.resolvePlan(
        r.planId,
        r.items.map((i) => ({ itemId: i.itemId, action: 'replace' as const })),
      ),
    );
    await h.waitFor((s) => (s.jobs.find((j) => j.id === ids[0])?.bytes ?? 0) > 0);
    h.svc.cancel(ids[0]!);
    await h.waitFor((s) => ids.every((x) => terminal(h, x)(s)));
    expect(h.job(ids[0]!).state).toBe('cancelled');
    expect(h.job(ids[1]!).state).toBe('failed');
    expect(h.job(ids[1]!).error?.code).toBe('REMOTE_PERMISSION_DENIED');
    expect(await readFile(join(dir, 'medium.bin'), 'utf8')).toBe('PRECIOUS');
    expect(await readFile(join(dir, 'secret.bin'), 'utf8')).toBe('PRECIOUS TOO');
    expect(await listDir(dir)).toEqual(['medium.bin', 'secret.bin']);
    expect(h.journal.list()).toEqual([]);
  });

  it('A11: remote mutation during download fails with "Remote file changed during download"', async () => {
    const h = await harness();
    const dir = await freshDest('mutate');
    h.next.dir = dir;
    await randomFile(R('mutating.bin'), 64 * MiB);
    const [id] = enqueued(await h.svc.chooseDestinationAndEnqueue(sessionId, [R('mutating.bin')]));
    await h.waitFor((s) => (s.jobs.find((j) => j.id === id)?.bytes ?? 0) > 0);
    const pids = fx.sessionPids();
    signalAll(pids, 'SIGSTOP');
    const fh = await open(R('mutating.bin'), 'r+');
    await fh.write(Buffer.from('changed!'), 0, 8, 1024); // same size, new mtime
    await fh.close();
    await utimes(R('mutating.bin'), new Date(), new Date(Date.now() + 5000));
    signalAll(pids, 'SIGCONT');
    await h.waitFor(terminal(h, id!));
    expect(h.job(id!).state).toBe('failed');
    expect(h.job(id!).error).toMatchObject({
      code: 'REMOTE_CHANGED',
      message: 'Remote file changed during download',
    });
    expect((await listDir(dir)).filter((n) => n.startsWith('mutating'))).toEqual([]);
    // Truncation mid-download is caught too.
    await randomFile(R('mutating.bin'), 64 * MiB);
    const [id2] = enqueued(await h.svc.chooseDestinationAndEnqueue(sessionId, [R('mutating.bin')]));
    await h.waitFor((s) => (s.jobs.find((j) => j.id === id2)?.bytes ?? 0) > 0);
    signalAll(fx.sessionPids(), 'SIGSTOP');
    await truncate(R('mutating.bin'), 1024);
    signalAll(fx.sessionPids(), 'SIGCONT');
    await h.waitFor(terminal(h, id2!));
    expect(h.job(id2!).error?.code).toBe('REMOTE_CHANGED');
    await h.waitFor((s) => s.jobs.every((j) => j.state !== 'queued' && j.state !== 'downloading'));
  });

  it('A11: failed finalization keeps an identifiable partial, never reports completion; cleanup can be retried', async () => {
    const h = await harness();
    const dir = await freshDest('finalize');
    h.next.dir = dir;
    h.hooks.beforeFinalize = () => chmod(dir, 0o555);
    const [id] = enqueued(await h.svc.chooseDestinationAndEnqueue(sessionId, [R('ordinary.bin')]));
    await h.waitFor(terminal(h, id!));
    h.hooks.beforeFinalize = undefined;
    const j = h.job(id!);
    expect(j.state).toBe('failed');
    expect(j.error?.code).toBe('FINALIZATION_FAILED');
    expect(j.finalPath).toBeNull();
    expect(j.leftoverPartial).toMatch(/ordinary\.bin\.[0-9a-f]{8}\.part$/);
    expect(await sha256(j.leftoverPartial!)).toBe(hashes['ordinary.bin']); // data kept
    expect(h.journal.list().map((e) => e.partPath)).toEqual([j.leftoverPartial]);
    await expect(h.svc.retryCleanup(id!)).rejects.toThrow(/Could not delete/);
    await chmod(dir, 0o755);
    await h.svc.retryCleanup(id!);
    expect(h.job(id!).leftoverPartial).toBeNull();
    expect(h.journal.list()).toEqual([]);
    expect((await listDir(dir)).filter((n) => n.startsWith('ordinary'))).toEqual([]);
    await h.waitFor((s) =>
      s.jobs.every((j2) => j2.state !== 'queued' && j2.state !== 'downloading'),
    );
  });

  it('A12: malicious and unsupported remote names need a local rename; distinct names never share a path', async () => {
    const win = await harness({ platform: 'win32' });
    const dir = await freshDest('names');
    win.next.dir = dir;
    const r = await win.svc.chooseDestinationAndEnqueue(
      sessionId,
      ['..\\..\\evil.txt', 'line\nbreak.txt', 'CON.txt', 'ordinary.bin'].map(R),
    );
    if (r.status !== 'needsDecision') throw new Error(r.status);
    expect(r.readyCount).toBe(1);
    expect(r.items.map((i) => [i.remoteName, i.issue, i.suggestedName])).toEqual([
      ['..\\..\\evil.txt', 'invalidName', '.._.._evil.txt'],
      ['line\nbreak.txt', 'invalidName', 'line_break.txt'],
      ['CON.txt', 'invalidName', '_CON.txt'],
    ]);
    // A rename containing a separator or traversal is refused in main.
    await expect(
      win.svc.resolvePlan(
        r.planId,
        r.items.map((i) => ({
          itemId: i.itemId,
          action: 'rename' as const,
          name: '../escape.txt',
        })),
      ),
    ).rejects.toThrow(/can’t be used/);
    const ids = enqueued(
      await win.svc.resolvePlan(
        r.planId,
        r.items.map((i) => ({
          itemId: i.itemId,
          action: 'rename' as const,
          name: i.suggestedName,
        })),
      ),
    );
    await win.waitFor((s) => ids.every((x) => terminal(win, x)(s)));
    expect(await listDir(dir)).toEqual([
      '.._.._evil.txt',
      '_CON.txt',
      'line_break.txt',
      'ordinary.bin',
    ]);
    expect(await listDir(ROOT)).toEqual(['dest', 'files', 'outside', 'srv', 'state']);
    // Case-insensitive platforms: Readme.txt and README.txt would be one file.
    const mac = await harness({ platform: 'darwin' });
    const dir2 = await freshDest('case');
    mac.next.dir = dir2;
    const r2 = await mac.svc.chooseDestinationAndEnqueue(sessionId, [
      R('Readme.txt'),
      R('README.txt'),
    ]);
    if (r2.status !== 'needsDecision') throw new Error(r2.status);
    expect(r2.items.map((i) => i.issue)).toEqual(['duplicateName', 'duplicateName']);
    const ids2 = enqueued(
      await mac.svc.resolvePlan(r2.planId, [
        { itemId: r2.items[0]!.itemId, action: 'rename', name: 'Readme (lower).txt' },
        { itemId: r2.items[1]!.itemId, action: 'keepBoth' },
      ]),
    );
    await mac.waitFor((s) => ids2.every((x) => terminal(mac, x)(s)));
    expect(await listDir(dir2)).toEqual(['README.txt', 'Readme (lower).txt']);
    // Links and folders are never downloaded.
    const lr = await mac.svc.chooseDestinationAndEnqueue(sessionId, [R('link.bin'), FILES]);
    expect(lr).toEqual({
      status: 'enqueued',
      jobIds: [],
      skipped: [
        { remotePath: R('link.bin'), reason: "Links can't be downloaded." },
        { remotePath: FILES, reason: 'Only regular files can be downloaded.' },
      ],
    });
  });

  it('A12: never writes through a local symlink or outside the approved folder', async () => {
    const h = await harness();
    const dir = await freshDest('symlinks');
    h.next.dir = dir;
    await writeFile(join(OUTSIDE, 'target.bin'), 'OUTSIDE');
    await symlink(join(OUTSIDE, 'target.bin'), join(dir, 'ordinary.bin'));
    const r = await h.svc.chooseDestinationAndEnqueue(sessionId, [
      R('ordinary.bin'),
      R('zero.bin'),
    ]);
    if (r.status !== 'needsDecision') throw new Error(r.status);
    expect(r.items[0]).toMatchObject({
      issue: 'existsNotAFile',
      choices: ['keepBoth', 'rename', 'skip'],
    });
    await expect(
      h.svc.resolvePlan(r.planId, [{ itemId: r.items[0]!.itemId, action: 'replace' }]),
    ).rejects.toThrow(/not available/);
    const ids = enqueued(
      await h.svc.resolvePlan(r.planId, [{ itemId: r.items[0]!.itemId, action: 'keepBoth' }]),
    );
    // A symlink planted at the final name during the download is not followed.
    h.hooks.beforeFinalize = async (jobId) => {
      if (h.job(jobId).fileName === 'zero.bin')
        await symlink(join(OUTSIDE, 'zero-target.bin'), join(dir, 'zero.bin'));
    };
    const s = await h.waitFor((x) => x.conflict !== null);
    expect(s.conflict!.choices).toEqual(['keepBoth', 'skip']);
    h.svc.resolveConflict(s.conflict!.jobId, s.conflict!.promptId, 'keepBoth');
    await h.waitFor((x) => ids.every((id) => terminal(h, id)(x)));
    h.hooks.beforeFinalize = undefined;
    expect(await readFile(join(OUTSIDE, 'target.bin'), 'utf8')).toBe('OUTSIDE');
    expect(await listDir(OUTSIDE)).toEqual(['target.bin']); // nothing created through the dangling link
    expect(await sha256(join(dir, 'ordinary (1).bin'))).toBe(hashes['ordinary.bin']);
    expect((await lstat(join(dir, 'zero (1).bin'))).isFile()).toBe(true);
    expect((await lstat(join(dir, 'ordinary.bin'))).isSymbolicLink()).toBe(true);
  });

  it('cancel while the server is frozen finishes promptly and removes the partial', async () => {
    const h = await harness();
    const dir = await freshDest('frozen');
    h.next.dir = dir;
    const [id] = enqueued(await h.svc.chooseDestinationAndEnqueue(sessionId, [R('medium.bin')]));
    await h.waitFor((s) => (s.jobs.find((j) => j.id === id)?.bytes ?? 0) > 0);
    const pids = fx.sessionPids();
    signalAll(pids, 'SIGSTOP');
    const t0 = Date.now();
    h.svc.cancel(id!);
    await h.waitFor(terminal(h, id!), 10_000);
    metrics.cancelFrozen_ms = String(Date.now() - t0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(h.job(id!).state).toBe('cancelled');
    expect((await listDir(dir)).filter((n) => n.startsWith('medium'))).toEqual([]);
    // Stop the queue before resuming the server so the test stays isolated.
    await h.svc.cancelAll();
    signalAll(pids, 'SIGCONT');
    // The frozen session may now be unusable; reconnect for later tests.
    sessionId = await fx.connect();
  });

  it('A11: network loss fails the active job, pauses the rest; Continue after reconnecting to the same server', async () => {
    const h = await harness();
    const dir = await freshDest('netloss');
    h.next.dir = dir;
    const ids = enqueued(
      await h.svc.chooseDestinationAndEnqueue(sessionId, [
        R('medium.bin'),
        R('q1.bin'),
        R('q2.bin'),
      ]),
    );
    await h.waitFor((s) => (s.jobs.find((j) => j.id === ids[0])?.bytes ?? 0) > 0);
    signalAll(fx.sessionPids(), 'SIGKILL');
    const s = await h.waitFor((x) => terminal(h, ids[0]!)(x) && x.pause !== null);
    expect(h.job(ids[0]!).error?.code).toBe('CONNECTION_LOST');
    expect([h.job(ids[1]!).state, h.job(ids[2]!).state]).toEqual(['queued', 'queued']);
    expect(s.pause).toMatchObject({ reason: 'connectionLost', canContinue: false });
    expect(await listDir(dir)).toEqual([]);
    expect(() => h.svc.continueQueue()).toThrow(/Reconnect/);
    await new Promise((r) => setTimeout(r, 300));
    expect([h.job(ids[1]!).state, h.job(ids[2]!).state]).toEqual(['queued', 'queued']); // really paused
    sessionId = await fx.connect();
    expect(h.svc.getSnapshot().pause?.canContinue).toBe(true);
    h.svc.continueQueue();
    await h.waitFor((x) => ids.slice(1).every((id) => terminal(h, id)(x)));
    expect(h.job(ids[1]!).sessionId).toBe(sessionId);
    expect(await listDir(dir)).toEqual(['q1.bin', 'q2.bin']);
    expect(await sha256(join(dir, 'q1.bin'))).toBe(hashes['q1.bin']);
    // The failed one can be retried on the new session.
    const rid = h.svc.retry(ids[0]!);
    await h.waitFor(terminal(h, rid));
    expect(await sha256(join(dir, 'medium.bin'))).toBe(hashes['medium.bin']);
  }, 120_000);

  it('orphan partials: only journaled files are offered and deleted', async () => {
    const stateDir = join(ROOT, 'state', 'orphans');
    const dir = await freshDest('orphans');
    await mkdir(stateDir, { recursive: true });
    const ours = join(dir, 'report.pdf.abcd1234.part');
    const unrelated = join(dir, 'someone-else.part');
    await writeFile(ours, 'partial');
    await writeFile(unrelated, 'not ours');
    const j = new TransferJournal(stateDir);
    await j.load();
    const st = await lstat(ours, { bigint: true });
    await j.add({
      jobId: '00000000-0000-4000-8000-000000000001',
      partPath: ours,
      partId: `${st.dev}:${st.ino}`,
      finalPath: join(dir, 'report.pdf'),
      createdAt: 1,
    });
    await j.add({
      jobId: '00000000-0000-4000-8000-000000000002',
      partPath: join(dir, 'gone.part'),
      partId: null,
      finalPath: join(dir, 'gone'),
      createdAt: 1,
    });
    const h = await harness({ stateDir });
    expect(await h.svc.findStartupOrphans()).toEqual([{ partPath: ours, size: 7 }]);
    expect(await h.svc.resolveOrphans('delete')).toEqual({ failed: [] });
    expect(await listDir(dir)).toEqual(['someone-else.part']);
    expect(h.journal.list()).toEqual([]);
    await expect(h.svc.resolveOrphans('delete')).rejects.toThrow(/no leftover/);
  });

  it('jobs stay bound to their server: retry elsewhere and stale plans are refused', async () => {
    const h = await harness();
    const dir = await freshDest('binding');
    h.next.dir = dir;
    await writeFile(join(dir, 'ordinary.bin'), 'OLD');
    const r = await h.svc.chooseDestinationAndEnqueue(sessionId, [
      R('ordinary.bin'),
      R('zero.bin'),
    ]);
    if (r.status !== 'needsDecision') throw new Error(r.status);
    const old = sessionId;
    sessionId = await fx.connect(); // new session: old plan is stale
    await expect(
      h.svc.resolvePlan(r.planId, [{ itemId: r.items[0]!.itemId, action: 'skip' }]),
    ).rejects.toThrow(/Not connected/);
    await expect(h.svc.chooseDestinationAndEnqueue(old, [R('zero.bin')])).rejects.toThrow(
      /Not connected/,
    );
    expect(h.svc.getSnapshot().jobs).toEqual([]);
  });
});
