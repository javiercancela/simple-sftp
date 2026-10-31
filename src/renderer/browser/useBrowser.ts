// Browsing state for one connected session: current view, history, the one
// outstanding listing request, and stale-response rejection (spec 6).
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RequestTracker,
  currentOf,
  emptyHistory,
  moveHistory,
  pushHistory,
  type BrowseEntry,
  type History,
} from '../../shared/browse';
import { parentOf } from '../../shared/remote-path';
import { api } from '../api';

export type NavMode = 'push' | 'back' | 'forward' | 'refresh' | 'initial';

export type View =
  | { kind: 'none' }
  | { kind: 'ready'; path: string; entries: BrowseEntry[]; loadedAt: number }
  | { kind: 'error'; path: string; code: string; message: string; initial: boolean };

export interface Pending {
  requestId: string;
  path: string;
  mode: NavMode;
  startedAt: number;
}

export interface BrowserSession {
  sessionId: string;
  /** Server default directory (realpath of "."). */
  home: string | null;
  /** Profile's initial remote directory, if any. */
  initialDir: string | null;
}

export interface BrowserApi {
  view: View;
  history: History;
  pending: Pending | null;
  navigate(path: string, mode?: NavMode): void;
  back(): void;
  forward(): void;
  up(): void;
  refresh(): void;
  goHome(): void;
  cancel(): void;
  /** Path shown in the location field and used for relative input. */
  location: string;
}

export function useBrowser(session: BrowserSession): BrowserApi {
  const [view, setView] = useState<View>({ kind: 'none' });
  const [history, setHistory] = useState<History>(emptyHistory);
  const { sessionId } = session;
  // The first listing: the profile's folder, else the server default. The
  // component is keyed by session ID, so a new session starts from fresh state.
  const [initial] = useState<Pending>(() => ({
    requestId: crypto.randomUUID(),
    path: session.initialDir ?? session.home ?? '/',
    mode: 'initial',
    startedAt: performance.now(),
  }));
  const [pending, setPending] = useState<Pending | null>(initial);
  const tracker = useRef(new RequestTracker());

  /** Send a listing request and apply its reply unless it went stale. */
  const run = useCallback(
    ({ requestId, path, mode }: Pending) => {
      // Begin replaces (supersedes) any outstanding request: its late reply is ignored.
      tracker.current.begin(sessionId, requestId);
      void api()
        .remote.list(sessionId, requestId, path)
        .then((r) => {
          if (!tracker.current.settle(sessionId, requestId)) return; // stale: drop
          setPending(null);
          if (!r.ok && r.error.code === 'CANCELLED') return;
          const shownPath = r.ok ? r.value.path : path;
          setHistory((h) =>
            mode === 'back'
              ? moveHistory(h, -1)
              : mode === 'forward'
                ? moveHistory(h, 1)
                : mode === 'refresh'
                  ? h
                  : pushHistory(h, shownPath),
          );
          setView(
            r.ok
              ? {
                  kind: 'ready',
                  path: r.value.path,
                  entries: r.value.entries,
                  loadedAt: Date.now(),
                }
              : {
                  kind: 'error',
                  path,
                  code: r.error.code,
                  message: r.error.message,
                  initial: mode === 'initial',
                },
          );
        });
    },
    [sessionId],
  );

  const navigate = useCallback(
    (path: string, mode: NavMode = 'push') => {
      const p: Pending = {
        requestId: crypto.randomUUID(),
        path,
        mode,
        startedAt: performance.now(),
      };
      setPending(p);
      run(p);
    },
    [run],
  );

  const cancel = useCallback(() => {
    const p = tracker.current.pending;
    if (!p) return;
    tracker.current.cancel();
    setPending(null);
    void api().remote.cancel(p.sessionId, p.requestId);
  }, []);

  useEffect(() => {
    run(initial);
    const t = tracker.current;
    return () => t.cancel();
  }, [run, initial]);

  const location = pending?.path ?? (view.kind === 'none' ? '' : view.path);
  const current = view.kind === 'none' ? currentOf(history) : view.path;

  return {
    view,
    history,
    pending,
    navigate,
    back: () => {
      const target = history.stack[history.index - 1];
      if (target !== undefined) navigate(target, 'back');
    },
    forward: () => {
      const target = history.stack[history.index + 1];
      if (target !== undefined) navigate(target, 'forward');
    },
    up: () => {
      if (current && current !== '/') navigate(parentOf(current));
    },
    refresh: () => {
      if (current) navigate(current, 'refresh');
    },
    goHome: () => navigate(session.home ?? '/'),
    cancel,
    location,
  };
}
