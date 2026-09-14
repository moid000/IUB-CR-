import { useEffect, useRef } from 'react';
import { Button } from './Button.jsx';

/** Accessible modal dialog: Esc to close, backdrop click, focus management. */
export function Modal({ open, onClose, title, children, footer = null, className = '' }) {
  const dialogRef = useRef(null);
  const previouslyFocused = useRef(null);
  // onClose stays fresh via a ref — the effect must NOT re-run on parent re-renders.
  // Otherwise a passing re-render (e.g. a toast dismissing) steals focus mid-typing,
  // and the focused X button would swallow Space/Enter and close the dialog.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    // Focus the first form field — never the close (X) button: keys the user
    // types must never fall through to the button that discards their work.
    const firstField = dialogRef.current?.querySelector('input, select, textarea');
    (firstField ?? dialogRef.current?.querySelector('button, [href]'))?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current?.(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCloseRef.current?.(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full max-w-md animate-fade-up rounded-2xl border border-slate-200/70 bg-white p-6 shadow-lift ${className}`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="text-sm text-slate-600">{children}</div>
        {footer && <div className="mt-6 flex justify-end gap-2.5">{footer}</div>}
      </div>
    </div>
  );
}

export { Button };
