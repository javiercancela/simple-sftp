import { useRef } from 'react';
import type { Profile } from '../../shared/profiles';
import { SIDEBAR_MAX, SIDEBAR_MIN } from '../../shared/settings';

interface Props {
  profiles: Profile[];
  selectedId: string | null;
  activeId: string | null;
  width: number;
  onSelect: (id: string) => void;
  onConnect: (id: string) => void;
  onAdd: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSettings: () => void;
  onResize: (width: number, commit: boolean) => void;
}

export function Sidebar(p: Props): React.JSX.Element {
  const listRef = useRef<HTMLUListElement>(null);
  const hasSel = p.selectedId !== null && p.profiles.some((x) => x.id === p.selectedId);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (p.profiles.length === 0) return;
    const idx = p.profiles.findIndex((x) => x.id === p.selectedId);
    let next = idx;
    if (e.key === 'ArrowDown') next = Math.min(p.profiles.length - 1, idx + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, idx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = p.profiles.length - 1;
    else if (e.key === 'Enter' && p.selectedId) {
      e.preventDefault();
      p.onConnect(p.selectedId);
      return;
    } else return;
    e.preventDefault();
    const target = p.profiles[next];
    if (target) p.onSelect(target.id);
  };

  const startDrag = (e: React.PointerEvent): void => {
    const startX = e.clientX;
    const startW = p.width;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const clamp = (w: number): number =>
      Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));
    const move = (ev: PointerEvent): void => p.onResize(clamp(startW + ev.clientX - startX), false);
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      p.onResize(clamp(startW + ev.clientX - startX), true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <aside className="sidebar" aria-label="Saved servers">
      <div className="sidebar-header">
        <h2 id="servers-heading">Servers</h2>
        <button type="button" className="primary" onClick={p.onAdd}>
          Add server
        </button>
      </div>
      {p.profiles.length === 0 ? (
        <p className="hint sidebar-empty">No saved servers.</p>
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          aria-labelledby="servers-heading"
          tabIndex={0}
          aria-activedescendant={hasSel ? `profile-${p.selectedId}` : undefined}
          onKeyDown={onKeyDown}
          className="profile-list"
          data-testid="profile-list"
        >
          {p.profiles.map((pr) => (
            <li
              key={pr.id}
              id={`profile-${pr.id}`}
              role="option"
              aria-selected={pr.id === p.selectedId}
              className={pr.id === p.selectedId ? 'selected' : undefined}
              onClick={() => {
                p.onSelect(pr.id);
                listRef.current?.focus();
              }}
              onDoubleClick={() => p.onConnect(pr.id)}
              data-testid="profile-item"
            >
              <span className="profile-name">
                {pr.name}
                {pr.id === p.activeId && <span className="active-dot" aria-label="(active)" />}
              </span>
              <span className="profile-sub">
                {pr.username}@{pr.host.includes(':') ? `[${pr.host}]` : pr.host}
                {pr.port !== 22 ? `:${pr.port}` : ''}
                {pr.authMode === 'privateKeyAndCertificate' ? ' · cert' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="sidebar-actions" role="toolbar" aria-label="Server actions">
        <button type="button" onClick={p.onEdit} disabled={!hasSel}>
          Edit
        </button>
        <button type="button" onClick={p.onDuplicate} disabled={!hasSel}>
          Duplicate
        </button>
        <button type="button" onClick={p.onDelete} disabled={!hasSel}>
          Delete
        </button>
        <button type="button" onClick={p.onSettings}>
          Settings
        </button>
      </div>
      <div
        className="resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={p.width}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 40 : 10;
          if (e.key === 'ArrowLeft') p.onResize(Math.max(SIDEBAR_MIN, p.width - step), true);
          else if (e.key === 'ArrowRight') p.onResize(Math.min(SIDEBAR_MAX, p.width + step), true);
        }}
      />
    </aside>
  );
}
