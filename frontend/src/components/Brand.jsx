/** Brand mark — consistent logo lockup used across the app. */
export function Brand({ compact = false, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="grid size-9 place-items-center rounded-xl bg-primary-600 shadow-sm">
        <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 4 2 8.667 12 13.333l10-4.666L12 4Z" fill="#fff" />
          <path d="M6 11.5v4.2c0 1.9 2.8 3.3 6 3.3s6-1.4 6-3.3v-4.2L12 15.5l-6-4Z" fill="#fff" opacity=".85" />
        </svg>
      </span>
      {!compact && (
        <span className="flex flex-col leading-tight">
          <span className="text-[15px] font-semibold tracking-tight text-slate-900">IUB Class Management</span>
          <span className="text-[11px] font-medium text-slate-400">Islamia University of Bahawalpur</span>
        </span>
      )}
    </span>
  );
}
