/** Brand mark — consistent logo lockup used across the app. */
export function Brand({ compact = false, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <img src={`${import.meta.env.BASE_URL}logo-256.png`} alt="Tri3M logo" className="size-9 rounded-xl object-contain" />
      {!compact && (
        <span className="flex flex-col leading-tight">
          <span className="text-[15px] font-semibold tracking-tight text-slate-900">Tri3M</span>
          <span className="text-[11px] font-medium tracking-wide text-slate-400">Connect &bull; Organize &bull; Succeed</span>
        </span>
      )}
    </span>
  );
}
