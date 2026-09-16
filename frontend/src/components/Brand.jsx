/** Brand mark — consistent logo lockup used across the app. */
export function Brand({ compact = false, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <img src="/logo-256.png" alt="T3M (Tri3M) logo" className="size-9 rounded-xl object-contain" />
      {!compact && (
        <span className="flex flex-col leading-tight">
          <span className="text-[15px] font-semibold tracking-tight text-slate-900">T3M (Tri3M)</span>
          <span className="text-[11px] font-medium text-slate-400">Islamia University of Bahawalpur</span>
        </span>
      )}
    </span>
  );
}
