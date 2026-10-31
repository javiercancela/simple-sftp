import { useState } from 'react';
import { formatSize } from '../../shared/browse';
import {
  isPending,
  isTerminal,
  type DownloadJobView,
  type DownloadsSnapshot,
} from '../../shared/downloads';
import { api } from '../api';

const STATE_LABEL: Record<DownloadJobView['state'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

interface Props {
  snapshot: DownloadsSnapshot;
  /** Message from the last enqueue (skipped items etc.). */
  note: string | null;
  onDismissNote: () => void;
  onError: (message: string) => void;
}

/** Bottom transfer queue (spec 7.4). Collapsed when empty; opens when a job is added. */
export function DownloadQueue({
  snapshot,
  note,
  onDismissNote,
  onError,
}: Props): React.JSX.Element {
  const { jobs, pause } = snapshot;
  const [collapsed, setCollapsed] = useState(true);
  // Open automatically whenever the number of jobs grows.
  const [seenCount, setSeenCount] = useState(jobs.length);
  if (seenCount !== jobs.length) {
    if (jobs.length > seenCount) setCollapsed(false);
    setSeenCount(jobs.length);
  }
  const pending = jobs.filter((j) => isPending(j.state)).length;
  const finished = jobs.filter((j) => isTerminal(j.state)).length;
  const active = jobs.find((j) => j.state === 'downloading');
  const run = (p: Promise<{ ok: boolean; error?: { message: string } }>): void =>
    void p.then((r) => {
      if (!r.ok && r.error) onError(r.error.message);
    });
  const open = !collapsed || pause !== null;

  const summary =
    jobs.length === 0
      ? 'No downloads'
      : [
          active ? `Downloading ${active.fileName}` : null,
          pending - (active ? 1 : 0) > 0 ? `${pending - (active ? 1 : 0)} queued` : null,
          finished > 0 ? `${finished} finished` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <section
      className={`queue${open ? ' open' : ''}`}
      aria-label="Downloads"
      data-testid="download-queue"
    >
      <header className="queue-head">
        <button
          type="button"
          className="queue-toggle"
          aria-expanded={open}
          aria-controls="queue-body"
          onClick={() => setCollapsed(open)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Downloads
        </button>
        <span className="queue-summary" data-testid="queue-summary">
          {summary}
        </span>
        <span className="spacer" />
        {pending > 0 && (
          <button type="button" onClick={() => run(api().downloads.cancelAll())}>
            Cancel all
          </button>
        )}
        {finished > 0 && (
          <button type="button" onClick={() => run(api().downloads.clearFinished())}>
            Clear finished
          </button>
        )}
      </header>
      {open && (
        <div id="queue-body" className="queue-body">
          {note && (
            <p className="queue-note" role="status" data-testid="queue-note">
              {note}{' '}
              <button type="button" className="link" onClick={onDismissNote}>
                Dismiss
              </button>
            </p>
          )}
          {pause && (
            <div className="queue-pause" role="alert" data-testid="queue-paused">
              <p>
                The connection to <strong>{pause.profileName}</strong> was lost.{' '}
                {pending > 0
                  ? `${pending} download${pending === 1 ? ' is' : 's are'} paused.`
                  : 'Nothing is waiting.'}{' '}
                {pause.canContinue ? '' : `Reconnect to ${pause.profileName} to continue.`}
              </p>
              <button
                type="button"
                className="primary"
                disabled={!pause.canContinue}
                onClick={() => run(api().downloads.continue())}
              >
                Continue downloads
              </button>
              <button type="button" onClick={() => run(api().downloads.cancelAll())}>
                Cancel downloads
              </button>
            </div>
          )}
          {jobs.length === 0 ? (
            <p className="queue-empty">Downloaded files appear here.</p>
          ) : (
            <ul className="queue-list">
              {jobs.map((j) => (
                <JobRow key={j.id} job={j} paused={pause !== null} run={run} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function JobRow({
  job: j,
  paused,
  run,
}: {
  job: DownloadJobView;
  paused: boolean;
  run: (p: Promise<{ ok: boolean; error?: { message: string } }>) => void;
}): React.JSX.Element {
  const pct = j.total ? Math.min(100, Math.floor((j.bytes / j.total) * 100)) : null;
  const progressText =
    j.state === 'downloading' || j.state === 'queued'
      ? `${formatSize(j.bytes)} of ${j.total === null ? 'unknown size' : formatSize(j.total)}${
          j.state === 'downloading' && j.speed !== null ? ` · ${formatSize(j.speed)}/s` : ''
        }`
      : j.state === 'completed'
        ? formatSize(j.total ?? j.bytes)
        : j.bytes > 0
          ? `stopped after ${formatSize(j.bytes)}`
          : '';
  return (
    <li
      className={`job job-${j.state}`}
      data-testid="download-row"
      data-state={j.state}
      data-bytes={j.bytes}
      data-name={j.fileName}
    >
      <div className="job-main">
        <span className="job-name" title={j.remotePath}>
          {j.finalPath ? j.finalPath.slice(j.destinationDir.length + 1) || j.fileName : j.fileName}
        </span>
        <span className={`job-state state-${j.state}`} data-testid="job-state">
          {j.state === 'queued' && paused ? 'Paused' : STATE_LABEL[j.state]}
          {j.state === 'downloading' && pct !== null ? ` ${pct}%` : ''}
        </span>
      </div>
      {j.state === 'downloading' && (
        // Indeterminate only when the server reported no size.
        <progress
          className="job-progress"
          max={j.total && j.total > 0 ? j.total : undefined}
          value={j.total && j.total > 0 ? j.bytes : undefined}
          aria-label={`Progress for ${j.fileName}`}
        />
      )}
      <div className="job-meta">
        <span className="job-dest" title={j.destinationDir}>
          {j.profileName} → {j.destinationDir}
        </span>
        <span className="job-bytes">{progressText}</span>
      </div>
      {j.error && j.state !== 'completed' && (
        <div className={j.state === 'failed' ? 'job-error' : 'job-note'} data-testid="job-error">
          <span>{j.error.message}</span>
          {j.error.detail && (
            <details>
              <summary>Details</summary>
              <code>
                {j.error.code}: {j.error.detail}
              </code>
            </details>
          )}
        </div>
      )}
      {j.leftoverPartial && (
        <div className="job-note" data-testid="job-partial">
          Partial file left at <code>{j.leftoverPartial}</code>
        </div>
      )}
      <div className="job-actions">
        {isPending(j.state) && (
          <button type="button" onClick={() => run(api().downloads.cancel(j.id))}>
            Cancel
          </button>
        )}
        {(j.state === 'failed' || j.state === 'cancelled') && (
          <button
            type="button"
            disabled={paused}
            title={paused ? 'Reconnect and continue first' : 'Download again from the start'}
            onClick={() => run(api().downloads.retry(j.id))}
          >
            Retry
          </button>
        )}
        {j.leftoverPartial && (
          <button type="button" onClick={() => run(api().downloads.retryCleanup(j.id))}>
            Delete partial file
          </button>
        )}
        {j.state === 'completed' && (
          <button type="button" onClick={() => run(api().downloads.reveal(j.id))}>
            Show in folder
          </button>
        )}
      </div>
    </li>
  );
}
