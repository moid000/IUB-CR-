export function Checkbox({ label, id, className = '', ...rest }) {
  const boxId = id ?? (label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-') : undefined);
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <input
        type="checkbox"
        id={boxId}
        className="size-4 rounded border-slate-300 text-primary-600 accent-primary-600"
        {...rest}
      />
      {label && <label htmlFor={boxId} className="cursor-pointer select-none text-sm text-slate-700">{label}</label>}
    </div>
  );
}
