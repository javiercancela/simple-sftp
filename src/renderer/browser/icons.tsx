// Small inline icons; symlinks get a distinct badge (spec 6).
import type { BrowseEntry } from '../../shared/browse';

const base = { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true } as const;

function Folder(): React.JSX.Element {
  return (
    <svg {...base} className="icon icon-folder">
      <path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" fill="currentColor" />
    </svg>
  );
}
function File(): React.JSX.Element {
  return (
    <svg {...base} className="icon icon-file">
      <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" />
      <path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" />
    </svg>
  );
}
function Other(): React.JSX.Element {
  return (
    <svg {...base} className="icon icon-other">
      <rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" />
    </svg>
  );
}
function LinkBadge(): React.JSX.Element {
  return (
    <svg {...base} className="icon-link-badge">
      <circle cx="8" cy="8" r="6.5" fill="var(--bg)" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.2 10.8l5-5M6.8 5.8h3.4v3.4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function EntryIcon({ entry }: { entry: BrowseEntry }): React.JSX.Element {
  if (entry.type === 'symlink') {
    return (
      <span className="icon-wrap icon-symlink" data-icon="symlink">
        {entry.linkTarget === 'directory' ? (
          <Folder />
        ) : entry.linkTarget === 'file' ? (
          <File />
        ) : (
          <Other />
        )}
        <LinkBadge />
      </span>
    );
  }
  return (
    <span className="icon-wrap" data-icon={entry.type}>
      {entry.type === 'directory' ? <Folder /> : entry.type === 'file' ? <File /> : <Other />}
    </span>
  );
}
