import { Link } from 'react-router-dom';
import { StaggerItem } from '../motion/primitives.jsx';
import { CountUp } from './CountUp.jsx';

/** Metric card — real backend counts only. Icon in a soft chip, strong value,
 *  quiet metadata. Whole card is a link when `to` is given. */
export function StatCard({ to, icon: Icon = null, label, value, hint }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
        {Icon && (
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-600 transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6">
            <Icon className="size-4" />
          </span>
        )}
      </div>
      <p className="mt-2.5 text-2xl font-semibold tracking-tight text-slate-900"><CountUp value={value} /></p>
      {hint && <p className="mt-0.5 truncate text-xs text-slate-500">{hint}</p>}
    </>
  );
  const surface = 'rounded-2xl border border-slate-200/80 bg-white p-4.5 shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-lift sm:p-5';
  return (
    <StaggerItem>
      {to ? (
        <Link to={to} className={`group block ${surface} hover:border-primary-200 hover:shadow-lift`}>{body}</Link>
      ) : (
        <div className={surface}>{body}</div>
      )}
    </StaggerItem>
  );
}
