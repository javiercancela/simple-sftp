import { useState } from 'react';
import type {
  CollisionChoice,
  ConflictPrompt,
  EnqueueResult,
  PlanDecision,
  PlanItemView,
} from '../../shared/downloads';
import { api } from '../api';
import { Dialog } from '../components/Dialog';

type Plan = Extract<EnqueueResult, { status: 'needsDecision' }>;
type Action = PlanDecision['action'];

const ACTION_LABEL: Record<Action, string> = {
  replace: 'Replace',
  keepBoth: 'Keep both',
  rename: 'Rename',
  skip: 'Skip',
};

function defaultAction(it: PlanItemView): Action {
  if (it.issue === 'invalidName' && it.choices.includes('rename')) return 'rename';
  if (it.choices.includes('keepBoth')) return 'keepBoth';
  return it.choices.includes('rename') ? 'rename' : 'skip';
}

/**
 * Files that need a decision before they are queued: an existing file, a name
 * that can't be used locally, or two files that would map to one name
 * (spec 7.2, 7.3). Nothing is replaced unless "Replace" is chosen here.
 */
export function PlanDialog({
  plan,
  onDone,
}: {
  plan: Plan;
  onDone: (result: EnqueueResult | null, error?: string) => void;
}): React.JSX.Element {
  const [actions, setActions] = useState<Record<string, Action>>(() =>
    Object.fromEntries(plan.items.map((i) => [i.itemId, defaultAction(i)])),
  );
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(plan.items.map((i) => [i.itemId, i.suggestedName])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const single = plan.items.length === 1 ? plan.items[0] : null;
  const title = single
    ? single.issue === 'exists'
      ? `“${single.localName}” already exists`
      : 'This file needs a new name'
    : `${plan.items.length} files need a decision`;

  const submit = async (override?: Action): Promise<void> => {
    setBusy(true);
    setError(null);
    const decisions: PlanDecision[] = plan.items.map((i) => {
      const action = override ?? actions[i.itemId]!;
      return action === 'rename'
        ? { itemId: i.itemId, action, name: names[i.itemId] ?? '' }
        : { itemId: i.itemId, action };
    });
    const r = await api().downloads.resolvePlan(plan.planId, decisions);
    setBusy(false);
    if (r.ok) onDone(r.value);
    else if (r.error.code === 'INVALID') setError(r.error.message);
    else onDone(null, r.error.message);
  };
  const cancel = (): void => {
    void api().downloads.cancelPlan(plan.planId);
    onDone({ status: 'canceled' });
  };

  return (
    <Dialog title={title} onClose={cancel} testId="plan-dialog" initialFocusId="plan-go">
      <p className="dialog-sub">
        Saving to <code>{plan.destinationDir}</code>
        {plan.readyCount > 0
          ? ` · ${plan.readyCount} other file${plan.readyCount === 1 ? '' : 's'} will download as usual`
          : ''}
      </p>
      <ul className="plan-items">
        {plan.items.map((it) => (
          <li key={it.itemId} data-testid="plan-item" data-issue={it.issue}>
            <div className="plan-name" title={it.remotePath}>
              {it.remoteName}
            </div>
            <p className="plan-msg">{it.message}</p>
            <div role="radiogroup" aria-label={`What to do with ${it.remoteName}`}>
              {it.choices.map((c) => (
                <label key={c} className="radio">
                  <input
                    type="radio"
                    name={`plan-${it.itemId}`}
                    checked={actions[it.itemId] === c}
                    onChange={() => setActions((a) => ({ ...a, [it.itemId]: c }))}
                  />
                  {ACTION_LABEL[c]}
                </label>
              ))}
            </div>
            {actions[it.itemId] === 'rename' && (
              <input
                className="plan-rename"
                aria-label={`New local name for ${it.remoteName}`}
                value={names[it.itemId] ?? ''}
                onChange={(e) => setNames((n) => ({ ...n, [it.itemId]: e.target.value }))}
              />
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={cancel} disabled={busy}>
          Cancel
        </button>
        {plan.items.length > 1 && (
          <button type="button" onClick={() => void submit('skip')} disabled={busy}>
            Skip all
          </button>
        )}
        <button
          id="plan-go"
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          Download
        </button>
      </div>
    </Dialog>
  );
}

const CONFLICT_LABEL: Record<CollisionChoice, string> = {
  replace: 'Replace',
  keepBoth: 'Keep both',
  skip: 'Skip',
};

/** The destination changed while the file was downloading (spec 7.3). */
export function ConflictDialog({ prompt }: { prompt: ConflictPrompt }): React.JSX.Element {
  const choose = (c: CollisionChoice): void =>
    void api().downloads.resolveConflict(prompt.jobId, prompt.promptId, c);
  return (
    <Dialog
      key={prompt.promptId}
      title={`“${prompt.fileName}” appeared in the folder`}
      onClose={() => choose('skip')}
      testId="conflict-dialog"
      role="alertdialog"
      initialFocusId="conflict-keep"
    >
      <p>{prompt.message}</p>
      <p className="dialog-sub">
        Folder: <code>{prompt.destinationDir}</code>
      </p>
      <div className="dialog-actions">
        {prompt.choices.includes('skip') && (
          <button type="button" onClick={() => choose('skip')}>
            Skip
          </button>
        )}
        {prompt.choices.includes('replace') && (
          <button type="button" className="danger" onClick={() => choose('replace')}>
            {CONFLICT_LABEL.replace}
          </button>
        )}
        {prompt.choices.includes('keepBoth') && (
          <button
            id="conflict-keep"
            type="button"
            className="primary"
            onClick={() => choose('keepBoth')}
          >
            {CONFLICT_LABEL.keepBoth}
          </button>
        )}
      </div>
    </Dialog>
  );
}

/** Pending downloads when quitting, switching server or disconnecting (spec 7.4). */
export function PendingDownloadsDialog({
  kind,
  count,
  serverName,
  onKeep,
  onCancelDownloads,
}: {
  kind: 'quit' | 'switch' | 'disconnect';
  count: number;
  serverName: string | null;
  onKeep: () => void;
  onCancelDownloads: () => void;
}): React.JSX.Element {
  const n = `${count} download${count === 1 ? '' : 's'}`;
  const text = {
    quit: `${n} ${count === 1 ? 'is' : 'are'} still in progress. Quitting cancels ${count === 1 ? 'it' : 'them'} and removes the partial files.`,
    switch: `${n} ${count === 1 ? 'is' : 'are'} still in progress. Connecting to ${serverName ?? 'another server'} cancels ${count === 1 ? 'it' : 'them'}; downloads never move to a different server.`,
    disconnect: `${n} ${count === 1 ? 'is' : 'are'} still in progress. Disconnecting cancels ${count === 1 ? 'it' : 'them'}.`,
  }[kind];
  const keep = { quit: 'Keep downloading', switch: 'Stay connected', disconnect: 'Stay connected' }[
    kind
  ];
  const go = {
    quit: 'Cancel downloads and quit',
    switch: 'Cancel downloads and switch',
    disconnect: 'Cancel downloads and disconnect',
  }[kind];
  return (
    <Dialog
      title="Downloads in progress"
      onClose={onKeep}
      testId="pending-dialog"
      role="alertdialog"
      initialFocusId="pending-keep"
    >
      <p>{text}</p>
      <div className="dialog-actions">
        <button type="button" className="danger" onClick={onCancelDownloads}>
          {go}
        </button>
        <button id="pending-keep" type="button" className="primary" onClick={onKeep}>
          {keep}
        </button>
      </div>
    </Dialog>
  );
}
