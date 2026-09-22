import { Link } from 'react-router-dom';
import { IconArrowRight } from '../icons.jsx';

/**
 * Dashboard metric tile. The wideMobile variant intentionally uses the full
 * final row on phones (instead of looking like a stretched ordinary card),
 * then returns to the same vertical rhythm as every tile on desktop.
 */
export function StatCard({ to, icon: Icon = null, label, value, hint, className = '', wideMobile = false }) {
  const top = (
    <div className="flex min-w-0 items-center gap-2.5">
      {Icon && (
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-600">
          <Icon className="size-4" />
        </span>
      )}
      <p className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
    </div>
  );

  const metric = (
    <div className={wideMobile ? 'min-w-0 text-right lg:text-left' : 'min-w-0'}>
      <p className="text-2xl font-semibold leading-none tracking-tight text-slate-900">{value}</p>
      {hint && <p className="mt-1 truncate text-[10px] text-slate-400">{hint}</p>}
    </div>
  );

  const body = wideMobile ? (
    <div className="flex h-full min-h-[64px] items-center justify-between gap-4 lg:min-h-[84px] lg:flex-col lg:items-stretch">
      {top}
      <div className="flex shrink-0 items-center gap-3 lg:mt-auto lg:items-end lg:justify-between">
        {metric}
        {to && <span className="grid size-7 shrink-0 place-items-center rounded-full bg-slate-50 text-slate-400 ring-1 ring-slate-100"><IconArrowRight className="size-3.5" /></span>}
      </div>
    </div>
  ) : (
    <div className="flex h-full min-h-[84px] flex-col">
      {top}
      <div className="mt-auto flex items-end justify-between gap-2 pt-3">
        {metric}
        {to && <IconArrowRight className="mb-1 size-3.5 shrink-0 text-slate-300" />}
      </div>
    </div>
  );

  const surface = 'group block h-full rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-lift [@media(hover:hover)]:active:scale-[0.99] sm:p-4';
  return to ? (
    <Link to={to} className={`${className} ${surface}`}>{body}</Link>
  ) : (
    <div className={`${className} ${surface}`}>{body}</div>
  );
}
