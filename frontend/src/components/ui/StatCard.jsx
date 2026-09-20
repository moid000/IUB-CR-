import { Link } from 'react-router-dom';
import { StaggerItem } from '../motion/primitives.jsx';
import { CountUp } from './CountUp.jsx';

/** Metric card — compact & professional: icon chip with the label inline,
 *  strong value below, quiet metadata. Whole card links when `to` is given. */
export function StatCard({ to, icon: Icon = null, label, value, hint, className = '' }) {
  const body = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2">
        {Icon && (
          <span className="grid size-7.5 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-600 transition-transform duration-300 group-hover:scale-110">
            <Icon className="size-4" />
          </span>
        )}
        <p className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      </div>
      <p className="mt-2 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl"><CountUp value={value} /></p>
      {hint && <p className="mt-0.5 truncate text-[10px] text-slate-400">{hint}</p>}
    </div>
  );
  const surface = 'group block h-full rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-soft transition-all duration-300 hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-lift sm:p-4';
  return (
    <StaggerItem className={className}>
      {to ? (
        <Link to={to} className={surface}>{body}</Link>
      ) : (
        <div className={surface}>{body}</div>
      )}
    </StaggerItem>
  );
}
