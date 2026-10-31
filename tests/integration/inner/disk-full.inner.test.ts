// Runs only inside the user+mount namespace set up by download-faults.test.ts,
// where INNER_DL is a freshly mounted 8 MiB tmpfs.
import { randomUUID } from 'node:crypto';
import { readdir, statfs } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ConnectionManager } from '../../../src/main/connections/connection-manager';
import { TrustStore } from '../../../src/main/connections/trust-store';
import { DownloadService } from '../../../src/main/downloads/download-service';
import { TransferJournal } from '../../../src/main/downloads/journal';
import type { ConnectionSnapshot } from '../../../src/shared/connection';
import type { Profile } from '../../../src/shared/profiles';

const E = process.env;

describe.skipIf(!E.SFTP_INNER_DISKFULL)('inner', () => {
  it('disk full: DISK_FULL, partial removed, space released', async () => {
    const dl = E.INNER_DL!;
    const fs0 = await statfs(dl);
    expect(fs0.blocks * fs0.bsize).toBeLessThanOrEqual(8 * 1024 * 1024);
    const profile: Profile = {
      id: randomUUID(),
      createdAt: '',
      updatedAt: '',
      name: 'disk',
      host: '127.0.0.1',
      port: Number(E.INNER_PORT),
      username: E.INNER_USER!,
      authMode: 'privateKeyAndCertificate',
      privateKeyPath: E.INNER_KEY!,
      certificatePath: E.INNER_CERT!,
      initialRemoteDirectory: null,
      downloadDirectory: null,
    };
    const trust = new TrustStore(E.INNER_STATE!);
    await trust.load();
    await trust.trust({
      host: '127.0.0.1',
      port: profile.port,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: E.INNER_HOST_FP!,
    });
    let snap: ConnectionSnapshot | null = null;
    let onReady: () => void = () => undefined;
    const ready = new Promise<void>((r) => (onReady = r));
    const mgr = new ConnectionManager({
      getProfile: () => profile,
      trust,
      emit: (s) => {
        snap = s;
        if (s.state === 'connected') onReady();
      },
    });
    const sessionId = await mgr.connect(profile.id);
    await ready;
    const journal = new TransferJournal(E.INNER_STATE!);
    await journal.load();
    let done: () => void = () => undefined;
    const finished = new Promise<void>((r) => (done = r));
    const svc: DownloadService = new DownloadService({
      connection: () => ({
        sessionId: snap!.sessionId,
        profileId: snap!.profileId,
        profileName: snap!.profileName,
        connected: snap!.state === 'connected',
      }),
      getSession: (id) => mgr.getSession(id),
      getProfile: () => profile,
      saveDialog: () => Promise.resolve(`${dl}/big.bin`),
      chooseDirectory: () => Promise.resolve(dl),
      defaultDownloadDir: () => dl,
      journal,
      platform: 'linux',
      emit: (s) => {
        if (['failed', 'completed', 'cancelled'].includes(s.jobs[0]?.state ?? '')) done();
      },
      reveal: () => undefined,
    });
    const r = await svc.chooseDestinationAndEnqueue(sessionId, [E.INNER_REMOTE!]);
    expect(r.status).toBe('enqueued');
    await finished;
    const job = svc.getSnapshot().jobs[0]!;
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('DISK_FULL');
    expect(job.leftoverPartial).toBeNull();
    expect(await readdir(dl)).toEqual([]);
    expect(journal.list()).toEqual([]);
    const fs1 = await statfs(dl);
    console.log(
      `[disk-full] ${job.bytes} of ${job.total} bytes written before ENOSPC on an 8 MiB tmpfs; error "${job.error?.message}"; free after cleanup ${((fs1.bavail * fs1.bsize) / 1024 / 1024).toFixed(1)} MiB`,
    );
    await mgr.shutdown();
  }, 60_000);
});
