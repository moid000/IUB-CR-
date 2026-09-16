import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '../ui/Button.jsx';
import { Modal } from '../ui/Modal.jsx';
import { Alert } from '../ui/Alert.jsx';
import { IconSearch } from '../icons.jsx';

/** Page header: title, description, and primary action slot. */
export function PageHeader({ title, description, children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="mb-6 flex flex-wrap items-start justify-between gap-3"
    >
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {children && <div className="flex items-center gap-2.5">{children}</div>}
    </motion.div>
  );
}

/** Filter toolbar — wraps search + selects, collapses gracefully on mobile. */
export function FilterBar({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.06, ease: [0.22, 1, 0.36, 1] }}
      className="mb-4 flex flex-wrap items-center gap-2.5"
    >
      {children}
    </motion.div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', label = 'Search' }) {
  return (
    <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
      <label htmlFor="admin-search" className="sr-only">{label}</label>
      <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <input
        id="admin-search"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="block w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-300 focus:border-primary-500"
      />
    </div>
  );
}

export function FilterSelect({ label, value, onChange, children, className = '' }) {
  const id = `filter-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <div className={className}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block rounded-lg border border-slate-200 bg-white py-2.5 pl-3 pr-8 text-sm text-slate-700 hover:border-slate-300 focus:border-primary-500"
      >
        {children}
      </select>
    </div>
  );
}

/**
 * Confirmation dialog for consequential actions (archive, remove…).
 * Explicit, non-destructive wording — never implies deletion.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel = 'Confirm',
  onConfirm,
  busy = false,
  error = null,
  danger = false,
  disabled = false,
}) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} disabled={disabled}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {body}
        {error && <Alert variant="danger">{error.message}</Alert>}
      </div>
    </Modal>
  );
}

/**
 * Create/edit modal wrapper: async submit handling, request-time disable,
 * server error display (message + field errors from the backend contract).
 * Children can be a render-prop receiving fieldErrors: (fields) => JSX.
 */
export function FormModal({ open, onClose, title, submitLabel = 'Save', onSubmit, children, size = 'md' }) {
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState(null);

  useEffect(() => {
    if (open) { setServerError(null); setFieldErrors(null); setBusy(false); }
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setServerError(null);
    setFieldErrors(null);
    setBusy(true);
    try {
      await onSubmit();
      onClose?.();
    } catch (err) {
      setServerError(err);
      if (err?.fields) setFieldErrors(err.fields);
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      className={size === 'lg' ? 'max-w-lg' : ''}
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="space-y-4">
          {typeof children === 'function' ? children(fieldErrors) : children}
          {serverError && (
            <Alert variant="danger">
              <p>{serverError.message}</p>
              {fieldErrors && (
                <p className="mt-1 text-xs opacity-80">
                  {Object.values(fieldErrors).join(' ')}
                </p>
              )}
            </Alert>
          )}
        </div>
        <div className="mt-6 flex justify-end gap-2.5">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy}>{submitLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Subtle inline success feedback strip (shown briefly after a mutation). */
export function SuccessFlash({ message }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, y: -8, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.99 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="mb-4"
        >
          <Alert variant="success" role="status">{message}</Alert>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
