// Read-only directory listing for the renderer (spec 6). Electron-free.
// Every request carries the session id and a renderer-chosen request id; a
// request that is cancelled or superseded by a newer one for the same session
// resolves to CANCELLED, so its late data never reaches the view.
import type { BrowseEntry, Listing } from '../../shared/browse';
import { isSafeEntryName, joinRemote, normalizeRemotePath } from '../../shared/remote-path';
import type { RemoteEntry } from '../../shared/transport-contract';
import { TransportError, isTransportError } from './errors';
import type { SftpSession } from './transport';

export interface BrowseDeps {
  getSession(sessionId: string): SftpSession | null;
  /** Max concurrent stat calls used to resolve symlink targets. */
  statConcurrency?: number;
}

const superseded = (): TransportError =>
  new TransportError('CANCELLED', 'This folder request was cancelled or replaced by a newer one.');

export class BrowseService {
  /** Latest request per session; older ones are superseded. */
  private readonly latest = new Map<string, string>();

  constructor(private readonly deps: BrowseDeps) {}

  private session(sessionId: string): SftpSession {
    const s = this.deps.getSession(sessionId);
    if (!s) throw new TransportError('DISCONNECTED', 'Not connected to this server any more.');
    return s;
  }

  async list(sessionId: string, requestId: string, rawPath: string): Promise<Listing> {
    const session = this.session(sessionId);
    const path = normalizeRemotePath(rawPath);
    this.latest.set(sessionId, requestId);
    const live = (): boolean => this.latest.get(sessionId) === requestId;
    let raw: RemoteEntry[];
    try {
      raw = await session.list(path);
    } catch (err) {
      if (!live()) throw superseded();
      if (this.deps.getSession(sessionId) !== session)
        throw new TransportError(
          'DISCONNECTED',
          'The connection closed while loading this folder.',
        );
      throw isTransportError(err)
        ? err
        : new TransportError('REMOTE_ERROR', 'Could not list this folder.');
    }
    if (!live()) throw superseded();
    const entries = await this.describe(session, path, raw, live);
    if (!live()) throw superseded();
    this.latest.delete(sessionId);
    return { sessionId, requestId, path, entries };
  }

  cancel(sessionId: string, requestId: string): boolean {
    if (this.latest.get(sessionId) !== requestId) return false;
    this.latest.delete(sessionId);
    return true;
  }

  /** Drop all state for a closed session. */
  forget(sessionId: string): void {
    this.latest.delete(sessionId);
  }

  private async describe(
    session: SftpSession,
    dir: string,
    raw: RemoteEntry[],
    live: () => boolean,
  ): Promise<BrowseEntry[]> {
    const entries: BrowseEntry[] = raw.map((e) => ({
      name: e.name,
      type: e.type,
      size: e.type === 'file' ? e.size : null,
      modifiedTime: e.modifiedTime,
      linkTarget: null,
      safeName: isSafeEntryName(e.name),
    }));
    // Resolve symlink targets (one level, no recursion) so the UI can offer
    // explicit navigation into links to folders.
    const links = entries.filter((e) => e.type === 'symlink' && e.safeName);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < links.length && live()) {
        const e = links[next++]!;
        try {
          const st = await session.stat(joinRemote(dir, e.name));
          e.linkTarget =
            st.type === 'directory' ? 'directory' : st.type === 'file' ? 'file' : 'other';
        } catch {
          e.linkTarget = 'broken';
        }
      }
    };
    const n = Math.min(this.deps.statConcurrency ?? 16, links.length);
    await Promise.all(Array.from({ length: n }, worker));
    return entries;
  }
}
