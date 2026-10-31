import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Element id inside the dialog that should receive focus first. */
  initialFocusId?: string;
  testId?: string;
  role?: 'dialog' | 'alertdialog';
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDialogElement>) => void;
}

/**
 * Modal built on <dialog>: native focus trapping and Escape handling.
 * Focus returns to whatever was focused before it opened (spec 8).
 */
export function Dialog({
  title,
  onClose,
  children,
  initialFocusId,
  testId,
  role,
  className,
  onKeyDown,
}: Props): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `dlg-${title.replace(/\W+/g, '-').toLowerCase()}`;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    if (initialFocusId) document.getElementById(initialFocusId)?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      role={role}
      data-testid={testId}
      className={className}
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
