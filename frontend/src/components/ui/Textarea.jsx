/** Multi-line input — identical surface language to <Input>. */
export function Textarea({
  label,
  error = null,
  hint = null,
  id,
  rows = 4,
  required = false,
  className = '',
  ...rest
}) {
  const areaId = id ?? (label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined);
  const errorId = error ? `${areaId}-error` : undefined;
  const hintId = hint ? `${areaId}-hint` : undefined;
  return (
    <div className={`w-full ${className}`}>
      {label && (
        <label htmlFor={areaId} className="mb-1.5 block text-sm font-medium text-slate-700">
          {label} {required && <span className="text-red-500" aria-hidden="true">*</span>}
        </label>
      )}
      <textarea
        id={areaId}
        rows={rows}
        className={`block w-full rounded-lg border bg-white px-3.5 py-2.5 text-sm text-slate-900
          placeholder:text-slate-400 transition-colors
          disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400
          ${error
            ? 'border-red-300 hover:border-red-400 focus:border-red-500'
            : 'border-slate-200 hover:border-slate-300 focus:border-primary-500'}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
        {...rest}
      />
      {hint && !error && <p id={hintId} className="mt-1.5 text-xs text-slate-500">{hint}</p>}
      {error && <p id={errorId} role="alert" className="mt-1.5 text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}
