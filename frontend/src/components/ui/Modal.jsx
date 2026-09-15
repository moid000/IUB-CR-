import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from './Button.jsx';

const EASE = [0.22, 1, 0.36, 1];

/** Accessible modal dialog: Esc to close, backdrop click, focus management.
 *  Animated entrance/exit: backdrop fades, card rises + unfades. */
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

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: EASE }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) onCloseRef.current?.(); }}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={`flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-lift ${className}`}
            initial={{ opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.99 }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            <div className="mb-4 flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
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
            {/* scrollable body — tall forms stay usable on small screens */}
            <div className={`min-h-0 flex-1 overflow-y-auto px-6 text-sm text-slate-600 ${footer ? 'pb-2' : 'pb-6'}`}>{children}</div>
            {footer && <div className="mt-4 flex shrink-0 justify-end gap-2.5 px-6 pb-6">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export { Button };
