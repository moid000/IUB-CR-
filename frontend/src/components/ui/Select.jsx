export function Select({ label, error = null, id, className = '', children, ...rest }) {
  const selectId = id ?? (label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined);
  return (
    <div className={`w-full ${className}`}>
      {label && (
        <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={`block w-full appearance-none rounded-lg border bg-white bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 20 20%22 fill=%22%2394a3b8%22%3E%3Cpath fill-rule=%22evenodd%22 d=%22M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06Z%22 clip-rule=%22evenodd%22/%3E%3C/svg%3E')] bg-[position:right_0.75rem_center] bg-no-repeat py-2.5 pl-3.5 pr-10 text-sm text-slate-900
          ${error ? 'border-red-300' : 'border-slate-200 hover:border-slate-300 focus:border-primary-500'}`}
        aria-invalid={error ? true : undefined}
        {...rest}
      >
        {children}
      </select>
      {error && <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}
