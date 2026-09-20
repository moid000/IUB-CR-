import { Link } from 'react-router-dom';
import { Card } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { MiniEmpty } from '../ui/MiniEmpty.jsx';
import { IconCalendar, IconArrowRight, IconBell } from '../icons.jsx';
import { usePkNow } from './TimetableDay.jsx';
import { fmtRoom, fmtTime } from '../../admin/format.js';

/**
 * Shared mobile-first dashboard building blocks (Student + CR Overview):
 * DashboardHero — time-aware greeting, full PKT date, section meta chips.
 * TodayClassesCard — today's classes with LIVE state (ongoing class gets
 *   the emerald "Now" treatment, finished classes dim) so the dashboard
 *   feels as alive as the timetable page.
 * DueChip — human deadline countdown ("2d left", amber near, red overdue).
 */

const TZ = 'Asia/Karachi';

function greetingFor(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Big friendly date line: "Sunday, 20 September". */
function pkDateLine() {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ,
  }).format(new Date());
}

export function Chip({ children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200/70 bg-white/70 px-2 py-1 text-[11px] font-medium text-slate-600">
      {children}
    </span>
  );
}

export function DashboardHero({ roleLabel, name, section, status, extraChips = [] }) {
  const now = usePkNow(true);
  const hour = Number(now.hm.split(':')[0]);
  const firstName = (name ?? '').split(' ')[0];

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white via-white to-primary-50/60 p-5 shadow-soft sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-primary-600">{pkDateLine()}</p>
          <Badge variant="primary" className="mt-2.5">{roleLabel}</Badge>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
            {greetingFor(hour)}{firstName ? `, ${firstName}` : ''} 👋
          </h2>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium
          ${status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
          <span className={`size-1.5 rounded-full ${status === 'active' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
          Section {status}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        <Chip>Section <span className="font-semibold text-slate-800">{section.name}</span></Chip>
        {section.department?.name && <Chip>{section.department.name}</Chip>}
        {section.semester != null && <Chip>Semester {section.semester}</Chip>}
        {extraChips}
      </div>
    </section>
  );
}

/** Live-state class row — mirrors the timetable page's timeline states. */
function ClassRow({ c }) {
  const now = usePkNow(true);
  const ongoing = c.startTime <= now.hm && now.hm < c.endTime;
  const past = now.hm >= c.endTime;
  return (
    <li
      className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 ${
        ongoing
          ? 'border-emerald-200 bg-emerald-50/50 ring-1 ring-emerald-400/50'
          : 'border-slate-100 bg-slate-50/60'
      } ${past ? 'opacity-55' : ''}`}
    >
      <div className="shrink-0 text-right">
        <p className={`font-mono text-[13px] font-semibold leading-tight ${ongoing ? 'text-emerald-700' : 'text-slate-800'}`}>
          {fmtTime(c.startTime)}
        </p>
        <p className="mt-0.5 font-mono text-[10px] leading-tight text-slate-400">{fmtTime(c.endTime)}</p>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-800">{c.subject?.name ?? 'Class'}</p>
        <p className="mt-0.5 truncate text-xs text-slate-500">
          {c.subject?.code}{c.room ? ` · Room ${fmtRoom(c.room)}` : ''}
        </p>
      </div>
      {ongoing && (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
          Now
        </span>
      )}
    </li>
  );
}

export function TodayClassesCard({ slots, loading, to, linkLabel, emptyText }) {
  const sorted = [...(slots ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime));

  let content;
  if (loading) {
    content = (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-14 skeleton-shimmer rounded-xl" />)}
      </div>
    );
  } else if (sorted.length === 0) {
    content = <MiniEmpty icon={IconCalendar} text={emptyText} />;
  } else {
    content = (
      <ul className="space-y-2">
        {sorted.map((c) => <ClassRow key={c._id} c={c} />)}
      </ul>
    );
  }

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          Today's classes
          {!loading && sorted.length > 0 && (
            <Badge variant="neutral">{sorted.length}</Badge>
          )}
        </h3>
        <Link to={to} className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
          {linkLabel} <IconArrowRight className="size-3.5" />
        </Link>
      </div>
      {content}
    </Card>
  );
}

/** Deadline countdown chip — "2d left", amber under 24h, red when passed. */
export function DueChip({ deadline, passed }) {
  const ms = new Date(deadline) - Date.now();
  const mins = Math.floor(ms / 60000);
  let text;
  if (ms <= 0 || passed) text = 'Overdue';
  else if (mins < 60) text = `${mins}m left`;
  else if (mins < 24 * 60) text = `${Math.floor(mins / 60)}h left`;
  else text = `${Math.floor(mins / (24 * 60))}d left`;

  const overdue = ms <= 0 || passed;
  const cls = overdue
    ? 'bg-red-50 text-red-700'
    : mins < 24 * 60
      ? 'bg-amber-50 text-amber-700'
      : 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {overdue && <IconBell className="size-3" />}
      {text}
    </span>
  );
}
