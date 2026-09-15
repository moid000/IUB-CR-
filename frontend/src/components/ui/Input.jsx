export function Input({
  label,
  error = null,
  hint = null,
  id,
  className = '',
  ...rest
}) {
  const inputId = id ?? (label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined);
  const errorId = error ? `${inputId}-error` : undefined;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div className={`w-full ${className}`}>
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`block w-full rounded-lg border bg-white px-3.5 py-2.5 text-sm text-slate-900
          placeholder:text-slate-400 transition-colors
          disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400
          ${error
            ? 'border-red-300 focus:border-red-500'
            : 'border-slate-200 hover:border-slate-300 focus:border-primary-500'}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
        {...rest}
      />
      {hint && !error && <p id={hintId} className="mt-1.5 text-xs text-slate-500">{hint}</p>}
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 flex items-center gap-1 text-xs font-medium text-red-600">
          <svg className="size-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm-1-5a1 1 0 1 1 2 0 1 1 0 0 1-2 0Zm1-8a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-4.5A.75.75 0 0 0 10 5Z" clipRule="evenodd" />
          </svg>
          {error}
        </p>
      )}
    </div>
  );
}
