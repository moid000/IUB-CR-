const STYLES = {
  info: 'bg-primary-50 text-primary-800 border-primary-100',
  success: 'bg-emerald-50 text-emerald-800 border-emerald-100',
  warning: 'bg-amber-50 text-amber-800 border-amber-100',
  danger: 'bg-red-50 text-red-800 border-red-100',
};

/** Inline alert / inline form-level feedback. Not color-only — icon + text. */
export function Alert({ variant = 'info', children, className = '', ...rest }) {
  return (
    <div
      role={variant === 'danger' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm ${STYLES[variant] ?? STYLES.info} ${className}`}
      {...rest}
    >
      <svg className="mt-0.5 size-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        {variant === 'success' && <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 0 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />}
        {variant === 'danger' && <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clipRule="evenodd" />}
        {variant === 'warning' && <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03-.001l6.28 10.944c.335.502.168 1.562-.85 1.562H3.056c-1.018 0-1.185-1.06-.85-1.562L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 9.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" clipRule="evenodd" />}
        {variant === 'info' && <path fillRule="evenodd" d="M18 10A8 8 0 1 1 2 10a8 8 0 0 1 16 0Zm-8-4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 8.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" clipRule="evenodd" />}
      </svg>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
