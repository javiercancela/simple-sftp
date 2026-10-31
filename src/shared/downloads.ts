// Download contracts and pure rules (spec 7). No Electron or Node APIs.

export const DOWNLOAD_STATES = [
  'queued',
  'downloading',
  'completed',
  'failed',
  'cancelled',
] as const;
export type DownloadState = (typeof DOWNLOAD_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<DownloadState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);
export const isTerminal = (s: DownloadState): boolean => TERMINAL_STATES.has(s);
export const isPending = (s: DownloadState): boolean => s === 'queued' || s === 'downloading';

/**
 * Allowed job state changes. Terminal states are immutable: a duplicate or
 * late completion/failure event can never change them (spec 7.1).
 */
export function canTransition(from: DownloadState, to: DownloadState): boolean {
  switch (from) {
    case 'queued':
      return to === 'downloading' || to === 'cancelled' || to === 'failed';
    case 'downloading':
      return to === 'completed' || to === 'failed' || to === 'cancelled';
    default:
      return false;
  }
}

/** Download failure classes (spec 10). */
export const DOWNLOAD_ERROR_CODES = [
  'REMOTE_PERMISSION_DENIED',
  'REMOTE_NOT_FOUND',
  'REMOTE_CHANGED',
  'REMOTE_NOT_A_FILE',
  'REMOTE_ERROR',
  'CONNECTION_LOST',
  'SFTP_UNAVAILABLE',
  'LOCAL_PERMISSION_DENIED',
  'DISK_FULL',
  'INVALID_FILENAME',
  'DESTINATION_CHANGED',
  'FINALIZATION_FAILED',
  'LOCAL_ERROR',
] as const;
export type DownloadErrorCode = (typeof DOWNLOAD_ERROR_CODES)[number];

export interface DownloadError {
  code: DownloadErrorCode;
  message: string;
  /** Sanitized technical detail (no file contents, no credentials). */
  detail?: string;
}

export type CollisionChoice = 'replace' | 'keepBoth' | 'skip';

/** One job as shown in the queue. Byte counts are safe integers (< 2^53). */
export interface DownloadJobView {
  id: string;
  profileId: string;
  profileName: string;
  sessionId: string;
  remotePath: string;
  /** Local file name the job will create (before any "Keep both" number). */
  fileName: string;
  /** Approved destination folder (display only). */
  destinationDir: string;
  /** Final path once completed. */
  finalPath: string | null;
  state: DownloadState;
  bytes: number;
  /** Expected size; null when the server did not report one. */
  total: number | null;
  /** Approximate bytes per second while downloading. */
  speed: number | null;
  error: DownloadError | null;
  /** A partial file that is still on disk (cleanup failed, or finalization failed). */
  leftoverPartial: string | null;
  /** Retry of this job id, if any. */
  retryOf: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** Destination changed between approval and finalization: ask again. */
export interface ConflictPrompt {
  promptId: string;
  jobId: string;
  fileName: string;
  destinationDir: string;
  /** What is at the destination now. */
  existing: 'file' | 'notAFile';
  message: string;
  choices: CollisionChoice[];
}

export interface DownloadsPause {
  reason: 'connectionLost';
  profileId: string;
  profileName: string;
  /** True when a session to the same server (profile + host key) is connected. */
  canContinue: boolean;
}

export interface DownloadsSnapshot {
  revision: number;
  jobs: DownloadJobView[];
  pause: DownloadsPause | null;
  conflict: ConflictPrompt | null;
}

export const EMPTY_DOWNLOADS: DownloadsSnapshot = {
  revision: -1,
  jobs: [],
  pause: null,
  conflict: null,
};

export const pendingCount = (s: DownloadsSnapshot): number =>
  s.jobs.filter((j) => isPending(j.state)).length;

/** Plan item issues the user must resolve before files are queued. */
export type PlanIssue = 'exists' | 'existsNotAFile' | 'invalidName' | 'duplicateName';

export interface PlanItemView {
  itemId: string;
  remotePath: string;
  remoteName: string;
  /** Proposed local name (validated in main). */
  localName: string;
  issue: PlanIssue;
  message: string;
  /** Allowed actions for this item. */
  choices: Array<CollisionChoice | 'rename'>;
  /** Safe replacement name offered for rename. */
  suggestedName: string;
}

export type EnqueueResult =
  | { status: 'canceled' }
  | { status: 'enqueued'; jobIds: string[]; skipped: SkippedItem[] }
  | {
      status: 'needsDecision';
      planId: string;
      destinationDir: string;
      items: PlanItemView[];
      /** Items already fine; they are queued together with the decisions. */
      readyCount: number;
      skipped: SkippedItem[];
    };

export interface SkippedItem {
  remotePath: string;
  reason: string;
}

export interface PlanDecision {
  itemId: string;
  action: CollisionChoice | 'rename';
  /** Required for rename: a plain file name, validated again in main. */
  name?: string;
}

// ---------------------------------------------------------------------------
// Local file names (spec 7.2).

export type LocalPlatform = 'linux' | 'darwin' | 'win32' | string;

const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const WIN_BAD_CHARS = /[<>:"|?*]/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
const CONTROL = /[\u0000-\u001f\u007f]/;
export const MAX_NAME_BYTES = 255;

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

export type NameCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether a remote-derived name can be used as a local file name inside the
 * approved folder. Rejects traversal, separators, absolute names, control
 * characters and names the platform cannot store. Windows rules apply on
 * Windows; they are also unsafe-but-legal elsewhere, so only flagged there.
 */
export function checkLocalName(name: string, platform: LocalPlatform): NameCheck {
  if (name.length === 0) return { ok: false, reason: 'The name is empty.' };
  if (name === '.' || name === '..')
    return { ok: false, reason: 'The name refers to a folder (“.” or “..”).' };
  if (name.includes('/') || name.includes('\\'))
    return { ok: false, reason: 'The name contains a path separator (/ or \\).' };
  if (CONTROL.test(name)) return { ok: false, reason: 'The name contains control characters.' };
  if (/^[a-zA-Z]:/.test(name)) return { ok: false, reason: 'The name looks like a drive path.' };
  if (utf8Length(name) > MAX_NAME_BYTES)
    return { ok: false, reason: 'The name is too long for a local file.' };
  if (platform === 'win32') {
    if (WIN_BAD_CHARS.test(name))
      return { ok: false, reason: 'The name contains characters Windows does not allow.' };
    if (WIN_RESERVED.test(name)) return { ok: false, reason: 'The name is reserved on Windows.' };
    if (/[. ]$/.test(name))
      return { ok: false, reason: 'Windows does not allow names ending in a dot or space.' };
  }
  if (platform === 'darwin' && name.includes(':'))
    return { ok: false, reason: 'The name contains “:”, which macOS does not allow in files.' };
  return { ok: true };
}

/** A safe local name derived from an unusable one (offered for rename). */
export function suggestLocalName(name: string, platform: LocalPlatform): string {
  let s = name
    // eslint-disable-next-line no-control-regex -- control characters are replaced
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[/\\]/g, '_');
  if (platform === 'win32') s = s.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (platform === 'darwin') s = s.replace(/:/g, '_');
  if (/^[a-zA-Z]:/.test(s)) s = s.replace(':', '_');
  if (platform === 'win32' && WIN_RESERVED.test(s)) s = `_${s}`;
  if (s === '' || s === '.' || s === '..') s = 'download';
  while (utf8Length(s) > MAX_NAME_BYTES) s = s.slice(0, -1);
  return checkLocalName(s, platform).ok ? s : 'download';
}

/**
 * Key under which two names would refer to the same local file. macOS and
 * Windows file systems are normally case-insensitive (and macOS normalizes
 * Unicode); Linux compares bytes.
 */
export function collisionKey(name: string, platform: LocalPlatform): string {
  if (platform === 'darwin' || platform === 'win32') return name.normalize('NFC').toLowerCase();
  return name;
}

/** "report.pdf" → "report (2).pdf"; ".bashrc" → ".bashrc (2)"; "a.tar.gz" → "a (2).tar.gz". */
export function numberedName(name: string, n: number): string {
  const m = /^(.+?)((?:\.tar)?\.[^.\s]{1,10})?$/i.exec(name);
  const base = m?.[1] ?? name;
  const ext = m?.[2] ?? '';
  return `${base} (${n})${ext}`;
}

// ---------------------------------------------------------------------------
// Speed estimate over a sliding window (pure; caller supplies time).

export class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = [];
  constructor(private readonly windowMs = 3000) {}

  add(t: number, totalBytes: number): void {
    this.samples.push({ t, bytes: totalBytes });
    while (this.samples.length > 2 && t - (this.samples[0]?.t ?? t) > this.windowMs)
      this.samples.shift();
  }

  /** Bytes per second, or null until there is enough data. */
  rate(): number | null {
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    if (!a || !b || b.t - a.t < 250) return null;
    return Math.round(((b.bytes - a.bytes) * 1000) / (b.t - a.t));
  }
}
