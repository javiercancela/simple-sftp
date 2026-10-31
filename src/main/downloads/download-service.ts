// Download queue (spec 7): one active transfer, main-approved destinations,
// streaming with backpressure into an exclusive .part file, atomic promotion,
// collision decisions, cleanup and an app-owned journal. Electron-free: the
// native dialogs and "show in folder" are injected by main.ts.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  canTransition,
  checkLocalName,
  collisionKey,
  isPending,
  isTerminal,
  SpeedMeter,
  suggestLocalName,
  type CollisionChoice,
  type ConflictPrompt,
  type DownloadError,
  type DownloadJobView,
  type DownloadsSnapshot,
  type DownloadState,
  type EnqueueResult,
  type PlanDecision,
  type PlanIssue,
  type PlanItemView,
  type SkippedItem,
} from '../../shared/downloads';
import { normalizeRemotePath } from '../../shared/remote-path';
import { isTransportError } from '../connections/errors';
import type { SftpSession } from '../connections/transport';
import type { TransferJournal } from './journal';
import {
  approveDirectory,
  classifyLocalError,
  createPart,
  inspectTarget,
  LocalFsError,
  partNameFor,
  promoteKeepBoth,
  promoteNew,
  promoteReplace,
  removePart,
  sameTarget,
  TargetChangedError,
  verifyDirectory,
  type ApprovedDir,
  type PartFile,
  type TargetState,
} from './local-fs';

export interface ConnectionInfo {
  sessionId: string | null;
  profileId: string | null;
  profileName: string | null;
  connected: boolean;
}

export interface DownloadDeps {
  connection(): ConnectionInfo;
  getSession(sessionId: string): SftpSession | null;
  getProfile(
    id: string,
  ): { id: string; name: string; downloadDirectory: string | null } | undefined;
  /** Native Save dialog (main-owned). Resolves to an absolute path or null. */
  saveDialog(defaultPath: string): Promise<string | null>;
  /** Native folder picker (main-owned). Resolves to an absolute path or null. */
  chooseDirectory(defaultPath: string): Promise<string | null>;
  defaultDownloadDir(): string;
  journal: TransferJournal;
  platform: string;
  emit(snapshot: DownloadsSnapshot): void;
  reveal(finalPath: string): void;
  progressIntervalMs?: number;
  /**
   * Test seam: awaited after the transfer, before finalization, so tests can
   * make real filesystem changes at that moment. Not used in the app.
   */
  beforeFinalize?(jobId: string): Promise<void>;
  log?(message: string): void;
}

/** IPC-facing request errors (stable codes, sanitized messages). */
export class DownloadRequestError extends Error {
  constructor(
    readonly code: 'DISCONNECTED' | 'PAUSED' | 'NOT_FOUND' | 'STALE' | 'NOT_ALLOWED' | 'INVALID',
    message: string,
  ) {
    super(message);
  }
}

type Mode = 'new' | 'replace' | 'keepBoth';

interface Approval {
  dir: ApprovedDir;
  name: string;
  mode: Mode;
  /** For replace: the exact file the user agreed to replace. */
  replaceTarget: TargetState | null;
}

type AbortReason = { kind: 'cancel' } | { kind: 'error'; error: DownloadError };

interface Job {
  view: DownloadJobView;
  hostFingerprint: string;
  approval: Approval;
  initialMtime: number | null;
  abort: AbortController | null;
  abortReason: AbortReason | null;
  partId: string | null;
}

interface PlanItem {
  itemId: string;
  remotePath: string;
  remoteName: string;
  size: number | null;
  mtime: number | null;
  name: string;
  issue: PlanIssue | null;
  target: TargetState;
  mode: Mode;
  replaceTarget: TargetState | null;
}

interface Plan {
  planId: string;
  sessionId: string;
  profileId: string;
  profileName: string;
  hostFingerprint: string;
  dir: ApprovedDir;
  items: PlanItem[];
  skipped: SkippedItem[];
}

const MAX_JOBS_KEPT = 1000;
const safeSize = (n: number | null): number | null =>
  n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;

function remoteError(e: unknown): DownloadError {
  if (isTransportError(e)) {
    switch (e.code) {
      case 'REMOTE_NOT_FOUND':
        return REMOTE_NOT_FOUND;
      case 'REMOTE_PERMISSION_DENIED':
        return REMOTE_DENIED;
      case 'SFTP_UNAVAILABLE':
        return {
          code: 'SFTP_UNAVAILABLE',
          message: "The server's file transfer service stopped.",
          ...(e.detail ? { detail: e.detail } : {}),
        };
      case 'CONNECTION_LOST':
      case 'DISCONNECTED':
        return e.detail ? { ...LOST, detail: e.detail } : LOST;
      default:
        return { code: 'REMOTE_ERROR', message: 'The server returned an error.', detail: e.code };
    }
  }
  const err = e as { code?: unknown; message?: string };
  if (typeof err?.code === 'number') {
    if (err.code === 2) return REMOTE_NOT_FOUND;
    if (err.code === 3) return REMOTE_DENIED;
    return {
      code: 'REMOTE_ERROR',
      message: 'The server returned an error.',
      detail: `SFTP status ${err.code}`,
    };
  }
  if (err?.message === 'No response from server') return LOST;
  if (typeof err?.code === 'string' && /^E[A-Z]+$/.test(err.code))
    return classifyLocalError(e, 'the download folder').toDownloadError();
  const detail = err?.message?.slice(0, 200);
  return detail
    ? { code: 'REMOTE_ERROR', message: 'The download failed.', detail }
    : { code: 'REMOTE_ERROR', message: 'The download failed.' };
}

const REMOTE_NOT_FOUND: DownloadError = {
  code: 'REMOTE_NOT_FOUND',
  message: 'The file no longer exists on the server.',
};
const REMOTE_DENIED: DownloadError = {
  code: 'REMOTE_PERMISSION_DENIED',
  message: "The server doesn't allow your account to read this file.",
};
const LOST: DownloadError = {
  code: 'CONNECTION_LOST',
  message: 'The connection to the server was lost.',
};

const REMOTE_CHANGED: DownloadError = {
  code: 'REMOTE_CHANGED',
  message: 'Remote file changed during download',
};

export class DownloadService {
  private jobs: Job[] = [];
  private plans = new Map<string, Plan>();
  private active: Job | null = null;
  private activeDone: Promise<void> = Promise.resolve();
  private pause: { profileId: string; profileName: string; hostFingerprint: string } | null = null;
  private conflict: {
    prompt: ConflictPrompt;
    resolve: (c: CollisionChoice) => void;
    reject: (e: unknown) => void;
  } | null = null;
  private revision = 0;
  private watched = new Set<string>();
  private emitTimer: NodeJS.Timeout | null = null;
  /** Journal entries found at startup (offered for cleanup). */
  private startupOrphans = new Set<string>();

  constructor(private readonly deps: DownloadDeps) {}

  // ----- snapshot ---------------------------------------------------------

  getSnapshot(): DownloadsSnapshot {
    const conn = this.deps.connection();
    let canContinue = false;
    if (this.pause && conn.connected && conn.sessionId && conn.profileId === this.pause.profileId) {
      const s = this.deps.getSession(conn.sessionId);
      canContinue = !!s && s.hostKey.fingerprintSha256 === this.pause.hostFingerprint;
    }
    return {
      revision: this.revision,
      jobs: this.jobs.map((j) => ({ ...j.view, error: j.view.error ? { ...j.view.error } : null })),
      pause: this.pause
        ? {
            reason: 'connectionLost',
            profileId: this.pause.profileId,
            profileName: this.pause.profileName,
            canContinue,
          }
        : null,
      conflict: this.conflict ? { ...this.conflict.prompt } : null,
    };
  }

  private emitNow(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.revision++;
    this.deps.emit(this.getSnapshot());
  }

  private emitSoon(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.revision++;
      this.deps.emit(this.getSnapshot());
    }, this.deps.progressIntervalMs ?? 150);
  }

  /** Connection state changed: "Continue" availability may have changed. */
  connectionChanged(): void {
    if (this.pause) this.emitNow();
  }

  hasPending(): boolean {
    return this.jobs.some((j) => isPending(j.view.state));
  }

  /** Whether connecting to `profileId` must first ask about pending downloads. */
  connectNeedsConfirmation(profileId: string): boolean {
    if (!this.hasPending()) return false;
    if (this.deps.connection().connected) return true; // a new session ends the current one
    return this.jobs.some((j) => isPending(j.view.state) && j.view.profileId !== profileId);
  }

  // ----- state changes ----------------------------------------------------

  private set(job: Job, to: DownloadState, patch: Partial<DownloadJobView> = {}): boolean {
    if (!canTransition(job.view.state, to)) return false; // terminal states never change
    Object.assign(job.view, patch, { state: to });
    if (isTerminal(to)) {
      job.view.finishedAt = Date.now();
      job.view.speed = null;
    }
    this.emitNow();
    return true;
  }

  // ----- enqueue ----------------------------------------------------------

  private currentSession(sessionId: string): {
    session: SftpSession;
    profileId: string;
    profileName: string;
  } {
    const conn = this.deps.connection();
    const session = this.deps.getSession(sessionId);
    if (!conn.connected || conn.sessionId !== sessionId || !session || !conn.profileId)
      throw new DownloadRequestError('DISCONNECTED', 'Not connected to that server any more.');
    return { session, profileId: conn.profileId, profileName: conn.profileName ?? '' };
  }

  async chooseDestinationAndEnqueue(sessionId: string, rawPaths: string[]): Promise<EnqueueResult> {
    const { session, profileId, profileName } = this.currentSession(sessionId);
    if (this.pause)
      throw new DownloadRequestError(
        'PAUSED',
        'Downloads are paused. Continue or cancel them first.',
      );
    const profile = this.deps.getProfile(profileId);
    const skipped: SkippedItem[] = [];
    const files: Array<{
      remotePath: string;
      name: string;
      size: number | null;
      mtime: number | null;
    }> = [];
    const seen = new Set<string>();
    for (const raw of rawPaths) {
      const remotePath = normalizeRemotePath(raw);
      if (!remotePath || remotePath === '/' || seen.has(remotePath)) continue;
      seen.add(remotePath);
      const name = path.posix.basename(remotePath);
      try {
        const st = await session.lstat(remotePath);
        if (st.type === 'symlink')
          skipped.push({ remotePath, reason: "Links can't be downloaded." });
        else if (st.type !== 'file')
          skipped.push({ remotePath, reason: 'Only regular files can be downloaded.' });
        else files.push({ remotePath, name, size: safeSize(st.size), mtime: st.modifiedTime });
      } catch (e) {
        skipped.push({ remotePath, reason: remoteError(e).message });
      }
    }
    if (files.length === 0) return { status: 'enqueued', jobIds: [], skipped };

    const baseDir = profile?.downloadDirectory ?? this.deps.defaultDownloadDir();
    let dir: ApprovedDir;
    const items: PlanItem[] = [];
    if (files.length === 1 && rawPaths.length === 1) {
      const f = files[0]!;
      const proposed = checkLocalName(f.name, this.deps.platform).ok
        ? f.name
        : suggestLocalName(f.name, this.deps.platform);
      const chosen = await this.deps.saveDialog(path.join(baseDir, proposed));
      if (!chosen) return { status: 'canceled' };
      dir = await this.approve(path.dirname(chosen));
      items.push(this.planItem(f, path.basename(chosen)));
    } else {
      const chosen = await this.deps.chooseDirectory(baseDir);
      if (!chosen) return { status: 'canceled' };
      dir = await this.approve(chosen);
      for (const f of files) items.push(this.planItem(f, f.name));
    }
    // The session may have changed while the native dialog was open.
    this.currentSession(sessionId);
    const plan: Plan = {
      planId: randomUUID(),
      sessionId,
      profileId,
      profileName,
      hostFingerprint: session.hostKey.fingerprintSha256,
      dir,
      items,
      skipped,
    };
    return this.evaluate(plan);
  }

  private async approve(p: string): Promise<ApprovedDir> {
    try {
      return await approveDirectory(p);
    } catch (e) {
      const d = e instanceof LocalFsError ? e : classifyLocalError(e, 'that folder');
      throw new DownloadRequestError('NOT_ALLOWED', d.message);
    }
  }

  private planItem(
    f: { remotePath: string; name: string; size: number | null; mtime: number | null },
    name: string,
  ): PlanItem {
    return {
      itemId: randomUUID(),
      remotePath: f.remotePath,
      remoteName: f.name,
      size: f.size,
      mtime: f.mtime,
      name,
      issue: null,
      target: { kind: 'absent' },
      mode: 'new',
      replaceTarget: null,
    };
  }

  /** Names other pending jobs will create in `dir` (to avoid silent clashes). */
  private reservedKeys(dir: ApprovedDir): Set<string> {
    const keys = new Set<string>();
    for (const j of this.jobs) {
      if (isPending(j.view.state) && j.approval.dir.path === dir.path)
        keys.add(collisionKey(j.approval.name, this.deps.platform));
    }
    return keys;
  }

  /**
   * Check every undecided item: name validity, duplicates within the batch
   * and the queue, and what exists at the destination now.
   */
  private async evaluate(plan: Plan): Promise<EnqueueResult> {
    const reserved = this.reservedKeys(plan.dir);
    const batch = new Map<string, number>();
    for (const it of plan.items) {
      const k = collisionKey(it.name, this.deps.platform);
      batch.set(k, (batch.get(k) ?? 0) + 1);
    }
    const p = this.deps.platform;
    for (const it of plan.items) {
      if (it.mode === 'keepBoth') continue; // numbered at finalization if needed
      if (!checkLocalName(it.name, p).ok) {
        it.issue = 'invalidName';
        continue;
      }
      const k = collisionKey(it.name, p);
      if ((batch.get(k) ?? 0) > 1 || reserved.has(k)) {
        it.issue = 'duplicateName';
        continue;
      }
      try {
        it.target = await inspectTarget(plan.dir, it.name);
      } catch (e) {
        throw new DownloadRequestError(
          'NOT_ALLOWED',
          (e instanceof LocalFsError ? e : classifyLocalError(e, 'that folder')).message,
        );
      }
      if (it.mode === 'replace') {
        if (it.replaceTarget && sameTarget(it.target, it.replaceTarget)) {
          it.issue = null;
          continue;
        }
        if (it.target.kind === 'absent') {
          it.mode = 'new';
          it.replaceTarget = null;
          it.issue = null;
          continue;
        }
        it.mode = 'new'; // changed since the user decided: ask again
        it.replaceTarget = null;
      }
      it.issue =
        it.target.kind === 'absent'
          ? null
          : it.target.kind === 'file'
            ? 'exists'
            : 'existsNotAFile';
    }
    const open = plan.items.filter((i) => i.issue !== null);
    if (open.length === 0) {
      this.plans.delete(plan.planId);
      return this.commit(plan);
    }
    this.plans.set(plan.planId, plan);
    return {
      status: 'needsDecision',
      planId: plan.planId,
      destinationDir: plan.dir.path,
      items: open.map((i) => this.itemView(i)),
      readyCount: plan.items.length - open.length,
      skipped: plan.skipped,
    };
  }

  private itemView(i: PlanItem): PlanItemView {
    const p = this.deps.platform;
    const suggestedName = suggestLocalName(i.name, p);
    switch (i.issue) {
      case 'exists':
        return {
          itemId: i.itemId,
          remotePath: i.remotePath,
          remoteName: i.remoteName,
          localName: i.name,
          issue: 'exists',
          message: `A file named “${i.name}” already exists in this folder.`,
          choices: ['replace', 'keepBoth', 'rename', 'skip'],
          suggestedName,
        };
      case 'existsNotAFile':
        return {
          itemId: i.itemId,
          remotePath: i.remotePath,
          remoteName: i.remoteName,
          localName: i.name,
          issue: 'existsNotAFile',
          message: `“${i.name}” already exists in this folder and is not a regular file (for example a folder or link), so it can't be replaced.`,
          choices: ['keepBoth', 'rename', 'skip'],
          suggestedName,
        };
      case 'invalidName':
        return {
          itemId: i.itemId,
          remotePath: i.remotePath,
          remoteName: i.remoteName,
          localName: i.name,
          issue: 'invalidName',
          message: `The name can't be used for a local file: ${(checkLocalName(i.name, p) as { reason: string }).reason}`,
          choices: ['rename', 'skip'],
          suggestedName,
        };
      default:
        return {
          itemId: i.itemId,
          remotePath: i.remotePath,
          remoteName: i.remoteName,
          localName: i.name,
          issue: 'duplicateName',
          message: `Another file in this download would also be saved as “${i.name}” in this folder.`,
          choices: ['keepBoth', 'rename', 'skip'],
          suggestedName,
        };
    }
  }

  async resolvePlan(planId: string, decisions: PlanDecision[]): Promise<EnqueueResult> {
    const plan = this.plans.get(planId);
    if (!plan)
      throw new DownloadRequestError('STALE', 'That download request is no longer current.');
    try {
      this.currentSession(plan.sessionId);
    } catch (e) {
      this.plans.delete(planId);
      throw e;
    }
    const byId = new Map(decisions.map((d) => [d.itemId, d]));
    const open = plan.items.filter((i) => i.issue !== null);
    for (const it of open) {
      const d = byId.get(it.itemId);
      if (!d) throw new DownloadRequestError('INVALID', 'Choose what to do with every file.');
      const allowed = this.itemView(it).choices;
      if (!allowed.includes(d.action))
        throw new DownloadRequestError('INVALID', 'That choice is not available for this file.');
      // Validate everything before changing anything.
      if (d.action === 'rename') {
        const check = checkLocalName((d.name ?? '').normalize('NFC'), this.deps.platform);
        if (!check.ok)
          throw new DownloadRequestError(
            'INVALID',
            `“${d.name ?? ''}” can’t be used: ${check.reason}`,
          );
      }
    }
    const remaining: PlanItem[] = [];
    for (const it of plan.items) {
      const d = it.issue === null ? null : byId.get(it.itemId)!;
      if (!d) {
        remaining.push(it);
        continue;
      }
      switch (d.action) {
        case 'skip':
          plan.skipped.push({ remotePath: it.remotePath, reason: 'Skipped.' });
          continue;
        case 'replace':
          it.mode = 'replace';
          it.replaceTarget = it.target; // exactly what the user saw
          break;
        case 'keepBoth':
          it.mode = 'keepBoth';
          break;
        case 'rename': {
          it.name = (d.name ?? '').normalize('NFC');
          it.mode = 'new';
          break;
        }
      }
      it.issue = null;
      remaining.push(it);
    }
    plan.items = remaining;
    if (plan.items.length === 0) {
      this.plans.delete(planId);
      return { status: 'enqueued', jobIds: [], skipped: plan.skipped };
    }
    return this.evaluate(plan);
  }

  cancelPlan(planId: string): void {
    if (!this.plans.delete(planId))
      throw new DownloadRequestError('STALE', 'That download request is no longer current.');
  }

  private commit(plan: Plan): EnqueueResult {
    const ids: string[] = [];
    for (const it of plan.items) {
      const job = this.newJob({
        profileId: plan.profileId,
        profileName: plan.profileName,
        sessionId: plan.sessionId,
        hostFingerprint: plan.hostFingerprint,
        remotePath: it.remotePath,
        total: it.size,
        mtime: it.mtime,
        approval: { dir: plan.dir, name: it.name, mode: it.mode, replaceTarget: it.replaceTarget },
        retryOf: null,
      });
      ids.push(job.view.id);
    }
    this.watch(plan.sessionId);
    this.trim();
    this.emitNow();
    this.pump();
    return { status: 'enqueued', jobIds: ids, skipped: plan.skipped };
  }

  private newJob(a: {
    profileId: string;
    profileName: string;
    sessionId: string;
    hostFingerprint: string;
    remotePath: string;
    total: number | null;
    mtime: number | null;
    approval: Approval;
    retryOf: string | null;
  }): Job {
    const job: Job = {
      view: {
        id: randomUUID(),
        profileId: a.profileId,
        profileName: a.profileName,
        sessionId: a.sessionId,
        remotePath: a.remotePath,
        fileName: a.approval.name,
        destinationDir: a.approval.dir.path,
        finalPath: null,
        state: 'queued',
        bytes: 0,
        total: a.total,
        speed: null,
        error: null,
        leftoverPartial: null,
        retryOf: a.retryOf,
        createdAt: Date.now(),
        finishedAt: null,
      },
      hostFingerprint: a.hostFingerprint,
      approval: a.approval,
      initialMtime: a.mtime,
      abort: null,
      abortReason: null,
      partId: null,
    };
    this.jobs.push(job);
    return job;
  }

  private trim(): void {
    while (this.jobs.length > MAX_JOBS_KEPT) {
      const i = this.jobs.findIndex((j) => isTerminal(j.view.state) && !j.view.leftoverPartial);
      if (i === -1) break;
      this.jobs.splice(i, 1);
    }
  }

  /** Follow a session's end: a lost connection pauses the queue. */
  private watch(sessionId: string): void {
    if (this.watched.has(sessionId)) return;
    const s = this.deps.getSession(sessionId);
    if (!s) return;
    this.watched.add(sessionId);
    s.onClose((err) => {
      this.watched.delete(sessionId);
      const affected = this.jobs.filter(
        (j) => j.view.sessionId === sessionId && isPending(j.view.state),
      );
      if (affected.length === 0) return;
      if (err) {
        const first = affected[0]!;
        this.pause = {
          profileId: first.view.profileId,
          profileName: first.view.profileName,
          hostFingerprint: first.hostFingerprint,
        };
        if (this.active && this.active.view.sessionId === sessionId)
          this.abortJob(this.active, { kind: 'error', error: remoteError(err) });
        this.emitNow();
      } else {
        // Ended by the user (disconnect): nothing may continue on that session.
        for (const j of affected) this.cancelJob(j);
      }
    });
  }

  // ----- queue control ----------------------------------------------------

  private find(jobId: string): Job {
    const j = this.jobs.find((x) => x.view.id === jobId);
    if (!j) throw new DownloadRequestError('NOT_FOUND', 'That download no longer exists.');
    return j;
  }

  cancel(jobId: string): void {
    const j = this.find(jobId);
    if (!isPending(j.view.state))
      throw new DownloadRequestError('STALE', 'That download has already finished.');
    this.cancelJob(j);
  }

  private cancelJob(j: Job): void {
    if (j.view.state === 'queued') {
      this.set(j, 'cancelled');
      this.afterQueueChange();
    } else if (j.view.state === 'downloading') {
      this.abortJob(j, { kind: 'cancel' });
    }
  }

  private abortJob(j: Job, reason: AbortReason): void {
    j.abortReason ??= reason;
    j.abort?.abort();
    if (this.conflict && this.conflict.prompt.jobId === j.view.id) {
      const c = this.conflict;
      this.conflict = null;
      c.reject(new Error('aborted'));
    }
  }

  /** Cancel everything (switch server, disconnect, quit). Resolves once idle. */
  async cancelAll(): Promise<void> {
    // Queued first (without starting the next one), then the active one.
    for (const j of this.jobs) if (j.view.state === 'queued') this.set(j, 'cancelled');
    if (this.active) this.abortJob(this.active, { kind: 'cancel' });
    this.pause = null;
    this.emitNow();
    await this.activeDone;
  }

  continueQueue(): void {
    const snap = this.getSnapshot();
    if (!this.pause || !snap.pause)
      throw new DownloadRequestError('STALE', 'Downloads are not paused.');
    if (!snap.pause.canContinue)
      throw new DownloadRequestError(
        'NOT_ALLOWED',
        `Reconnect to ${this.pause.profileName} to continue these downloads.`,
      );
    const conn = this.deps.connection();
    for (const j of this.jobs) {
      if (
        j.view.state === 'queued' &&
        j.view.profileId === this.pause.profileId &&
        j.hostFingerprint === this.pause.hostFingerprint
      )
        j.view.sessionId = conn.sessionId!;
    }
    this.pause = null;
    this.watch(conn.sessionId!);
    this.emitNow();
    this.pump();
  }

  retry(jobId: string): string {
    const old = this.find(jobId);
    if (old.view.state !== 'failed' && old.view.state !== 'cancelled')
      throw new DownloadRequestError('STALE', 'Only failed or cancelled downloads can be retried.');
    if (this.pause)
      throw new DownloadRequestError(
        'PAUSED',
        'Downloads are paused. Continue or cancel them first.',
      );
    const conn = this.deps.connection();
    const s = conn.sessionId ? this.deps.getSession(conn.sessionId) : null;
    // Never redirect a job to another server: same profile and same host key.
    if (
      !conn.connected ||
      !s ||
      conn.profileId !== old.view.profileId ||
      s.hostKey.fingerprintSha256 !== old.hostFingerprint
    )
      throw new DownloadRequestError(
        'NOT_ALLOWED',
        `Connect to ${old.view.profileName} to retry this download.`,
      );
    this.jobs = this.jobs.filter((j) => j !== old);
    if (old.view.leftoverPartial) this.jobs.push(old); // keep the cleanup action visible
    const job = this.newJob({
      profileId: old.view.profileId,
      profileName: old.view.profileName,
      sessionId: conn.sessionId!,
      hostFingerprint: old.hostFingerprint,
      remotePath: old.view.remotePath,
      total: old.view.total,
      mtime: old.initialMtime,
      approval: old.approval,
      retryOf: old.view.id,
    });
    this.watch(conn.sessionId!);
    this.emitNow();
    this.pump();
    return job.view.id;
  }

  reveal(jobId: string): void {
    const j = this.find(jobId);
    if (j.view.state !== 'completed' || !j.view.finalPath)
      throw new DownloadRequestError('NOT_ALLOWED', 'Only completed downloads can be shown.');
    this.deps.reveal(j.view.finalPath);
  }

  async retryCleanup(jobId: string): Promise<void> {
    const j = this.find(jobId);
    const p = j.view.leftoverPartial;
    if (!p || !isTerminal(j.view.state))
      throw new DownloadRequestError('STALE', 'There is nothing to clean up for this download.');
    try {
      await removePart(p, j.partId);
    } catch (e) {
      throw new DownloadRequestError(
        'NOT_ALLOWED',
        `Could not delete ${p}: ${classifyLocalError(e, 'that folder').message}`,
      );
    }
    j.view.leftoverPartial = null;
    await this.deps.journal.remove(j.view.id).catch(() => undefined);
    this.emitNow();
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => !isTerminal(j.view.state) || !!j.view.leftoverPartial);
    this.emitNow();
  }

  resolveConflict(jobId: string, promptId: string, choice: CollisionChoice): void {
    const c = this.conflict;
    if (!c || c.prompt.jobId !== jobId || c.prompt.promptId !== promptId)
      throw new DownloadRequestError('STALE', 'That question is no longer current.');
    if (!c.prompt.choices.includes(choice))
      throw new DownloadRequestError('INVALID', 'That choice is not available.');
    this.conflict = null;
    c.resolve(choice);
    this.emitNow();
  }

  // ----- orphans ----------------------------------------------------------

  async findStartupOrphans(): Promise<Array<{ partPath: string; size: number }>> {
    const found = await this.deps.journal.findOrphans();
    this.startupOrphans = new Set(found.map((f) => f.jobId));
    return found.map((f) => ({ partPath: f.partPath, size: f.size }));
  }

  async resolveOrphans(action: 'delete' | 'keep'): Promise<{ failed: string[] }> {
    if (this.startupOrphans.size === 0)
      throw new DownloadRequestError('STALE', 'There are no leftover partial files.');
    const r = await this.deps.journal.resolveOrphans(this.startupOrphans, action);
    this.startupOrphans.clear();
    return r;
  }

  // ----- transfer ---------------------------------------------------------

  private afterQueueChange(): void {
    this.pump();
  }

  private pump(): void {
    if (this.active || this.pause) return;
    const next = this.jobs.find((j) => j.view.state === 'queued');
    if (!next) return;
    this.active = next;
    this.activeDone = this.run(next)
      .catch((e: unknown) => this.deps.log?.(`download internal error: ${(e as Error)?.message}`))
      .finally(() => {
        this.active = null;
        this.pump();
      });
  }

  private async run(job: Job): Promise<void> {
    const ac = new AbortController();
    job.abort = ac;
    job.abortReason = null;
    if (!this.set(job, 'downloading', { bytes: 0, speed: null, error: null })) return;
    const { dir } = job.approval;
    const journal = this.deps.journal;
    let part: PartFile | null = null;
    let partPath: string | null = null;
    let fhClosed = false;
    let ws: Writable | null = null;
    let keepPartial = false;
    let progressTimer: NodeJS.Timeout | null = null;
    let offClose: () => void = () => undefined;
    let session: SftpSession | null = null;
    let bytes = 0;
    const aborted = (): boolean => ac.signal.aborted;
    // Remote calls can hang on a frozen server; cancel must not wait for them.
    const guard = <T>(p: Promise<T>): Promise<T> => {
      p.catch(() => undefined);
      return Promise.race([p, abortPromise(ac.signal)]);
    };

    try {
      session = this.deps.getSession(job.view.sessionId);
      if (!session)
        throw Object.assign(new Error('no session'), {
          dl: {
            code: 'CONNECTION_LOST',
            message: `Not connected to ${job.view.profileName} any more.`,
          } satisfies DownloadError,
        });
      offClose = session.onClose((err) =>
        this.abortJob(job, { kind: 'error', error: err ? remoteError(err) : LOST }),
      );
      await verifyDirectory(dir);
      const pre = await guard(session.lstat(job.view.remotePath));
      if (pre.type !== 'file')
        throw Object.assign(new Error('not a file'), {
          dl: {
            code: 'REMOTE_NOT_A_FILE',
            message: 'The remote path is no longer a regular file.',
          } satisfies DownloadError,
        });
      const expected = safeSize(pre.size);
      job.view.total = expected;
      if (aborted()) throw new Error('aborted');

      const partName = partNameFor(job.approval.name);
      partPath = path.join(dir.path, partName);
      await journal.add({
        jobId: job.view.id,
        partPath,
        partId: null,
        finalPath: path.join(dir.path, job.approval.name),
        createdAt: Date.now(),
      });
      part = await createPart(dir, partName);
      job.partId = part.id;
      await journal.setPartId(job.view.id, part.id);
      if (aborted()) throw new Error('aborted');

      // Stream: SFTP read stream → byte counter → file. pipeline() applies
      // backpressure end to end; memory stays at a few buffers.
      const meter = new SpeedMeter();
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          bytes += chunk.length;
          if (expected !== null && bytes > expected) {
            cb(Object.assign(new Error('grew'), { dl: REMOTE_CHANGED }));
            return;
          }
          cb(null, chunk);
        },
      });
      // flush: fsync before the stream closes the file, so the data is on
      // disk before the file is promoted.
      ws = part.fh.createWriteStream({ highWaterMark: 256 * 1024, flush: true });
      progressTimer = setInterval(() => {
        meter.add(Date.now(), bytes);
        job.view.bytes = bytes;
        job.view.speed = meter.rate();
        this.emitSoon();
      }, this.deps.progressIntervalMs ?? 200);
      const rs = session.createReadStream(job.view.remotePath);
      const flow = pipeline(rs, counter, ws, { signal: ac.signal });
      flow.catch(() => undefined);
      // A frozen server may never let the read stream close; on abort, stop
      // waiting for it and make sure our file stream is closed.
      await Promise.race([flow, abortPromise(ac.signal)]);
      clearInterval(progressTimer);
      progressTimer = null;
      job.view.bytes = bytes;
      fhClosed = true; // pipeline() resolved: the stream flushed and closed the file
      if (aborted()) throw new Error('aborted');

      // Compare size and mtime before/after (not a cryptographic guarantee).
      const post = await guard(session.stat(job.view.remotePath));
      if (
        (expected !== null && bytes !== expected) ||
        safeSize(post.size) !== expected ||
        post.modifiedTime !== pre.modifiedTime
      )
        throw Object.assign(new Error('changed'), { dl: REMOTE_CHANGED });

      if (this.deps.beforeFinalize) await this.deps.beforeFinalize(job.view.id);
      if (aborted()) throw new Error('aborted');
      keepPartial = true; // from here a failure keeps the data identifiable
      const final = await this.finalize(job, part);
      if (final === null) {
        keepPartial = false;
        await this.cleanup(job, part.path, part.id);
        this.set(job, 'cancelled', {
          error: {
            code: 'DESTINATION_CHANGED',
            message: 'Skipped: a file with this name appeared in the folder.',
          },
        });
        return;
      }
      await journal.remove(job.view.id).catch(() => undefined);
      this.set(job, 'completed', { finalPath: final, fileName: path.basename(final) });
    } catch (e) {
      if (progressTimer) clearInterval(progressTimer);
      job.view.bytes = bytes;
      if (part && !fhClosed) await closeWriter(part, ws);
      // Set from other callbacks (cancel, session close) while we awaited.
      const reason = job.abortReason as AbortReason | null;
      let error: DownloadError | null;
      if (reason?.kind === 'cancel') error = null;
      else if (reason?.kind === 'error') error = reason.error;
      else if ((e as { dl?: DownloadError }).dl) error = (e as { dl: DownloadError }).dl;
      else if (e instanceof LocalFsError) error = e.toDownloadError();
      else error = remoteError(e);
      if (error?.code === 'CONNECTION_LOST' && session && !reason) {
        // A failed read does not say why; the session's close reason does
        // (connection lost vs. the SFTP subsystem stopping).
        const why = await closeReason(session, 4000);
        if (why) error = remoteError(why);
      }
      if (keepPartial && error?.code === 'FINALIZATION_FAILED' && part) {
        job.view.leftoverPartial = part.path; // identifiable; journaled for cleanup
      } else if (partPath) {
        await this.cleanup(job, partPath, job.partId);
      } else {
        await journal.remove(job.view.id).catch(() => undefined);
      }
      if (reason?.kind === 'cancel') this.set(job, 'cancelled');
      else this.set(job, 'failed', { error });
    } finally {
      offClose();
      job.abort = null;
    }
  }

  /** Remove our partial file; on failure report it and offer a retry. */
  private async cleanup(job: Job, partPath: string, partId: string | null): Promise<void> {
    try {
      await removePart(partPath, partId);
      await this.deps.journal.remove(job.view.id).catch(() => undefined);
      job.view.leftoverPartial = null;
    } catch {
      job.view.leftoverPartial = partPath;
    }
  }

  /** Promote the partial file, asking again if the destination changed. */
  private async finalize(job: Job, part: PartFile): Promise<string | null> {
    const { dir } = job.approval;
    let mode = job.approval.mode;
    let approved = job.approval.replaceTarget;
    const name = job.approval.name;
    for (;;) {
      try {
        if (mode === 'new') return await promoteNew(part, dir, name);
        if (mode === 'replace') return await promoteReplace(part, dir, name, approved!);
        return await promoteKeepBoth(part, dir, name);
      } catch (e) {
        if (!(e instanceof TargetChangedError)) throw e;
        if (e.now.kind === 'absent') {
          mode = 'new'; // nothing left to overwrite: just save it
          continue;
        }
        const choice = await this.ask(job, e.now);
        if (choice === 'skip') return null;
        if (choice === 'replace') {
          mode = 'replace';
          approved = e.now;
        } else mode = 'keepBoth';
      }
    }
  }

  private ask(job: Job, now: TargetState): Promise<CollisionChoice> {
    const prompt: ConflictPrompt = {
      promptId: randomUUID(),
      jobId: job.view.id,
      fileName: job.approval.name,
      destinationDir: job.approval.dir.path,
      existing: now.kind === 'file' ? 'file' : 'notAFile',
      message:
        now.kind === 'file'
          ? `“${job.approval.name}” changed in the folder while it was downloading. Choose again.`
          : `Something named “${job.approval.name}” appeared in the folder while it was downloading (not a regular file). Choose again.`,
      choices: now.kind === 'file' ? ['replace', 'keepBoth', 'skip'] : ['keepBoth', 'skip'],
    };
    return new Promise<CollisionChoice>((resolve, reject) => {
      this.conflict = { prompt, resolve, reject };
      this.emitNow();
    });
  }
}

function closeReason(session: SftpSession, ms: number): Promise<unknown> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      off();
      resolve(undefined);
    }, ms);
    const off = session.onClose((err) => {
      clearTimeout(t);
      resolve(err);
    });
  });
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fire = (): void => reject(new Error('aborted'));
    if (signal.aborted) fire();
    else signal.addEventListener('abort', fire, { once: true });
  });
}

/** Make sure the partial file is closed before it is removed. */
async function closeWriter(part: PartFile, ws: Writable | null): Promise<void> {
  if (ws && !ws.closed) {
    const closed = new Promise<void>((res) => {
      ws.once('close', () => res());
      setTimeout(res, 5000).unref();
    });
    ws.destroy();
    await closed;
  }
  await part.fh.close().catch(() => undefined);
}
