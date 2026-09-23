import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { MiniEmpty } from '../ui/MiniEmpty.jsx';
import { IconCalendar, IconArrowRight, IconBell, IconClipboard, IconMegaphone } from '../icons.jsx';
import { usePkNow } from './TimetableDay.jsx';
import { fmtRoom, fmtTime } from '../../admin/format.js';
import { api } from '../../api/client.js';
import TeacherConfirmationStatus from './TeacherConfirmationStatus.jsx';
import useTeacherConfirmationRefresh from '../../hooks/useTeacherConfirmationRefresh.js';

/**
 * Shared mobile-first dashboard building blocks (Student + CR Overview):
 * DashboardHero — time-aware greeting, full PKT date, section meta chips.
 * TodayClassesCard — today's classes with LIVE state (ongoing class gets
 *   the emerald "Now" treatment, finished classes dim) so the dashboard
 *   feels as alive as the timetable page.
 * DueChip — human deadline countdown ("2d left", amber near, red overdue).
 */

const TZ = 'Asia/Karachi';

/**
 * SWR-style dashboard data: paint the last known snapshot INSTANTLY (any
 * age), then silently revalidate in the background. Cold first visit keeps
 * skeletons until the network answers. Revisits/back-nav feel 0ms.
 */
export function useOverviewData(path, fetchOverview) {
  const [snap, setSnap] = useState(() => api.peek(path)?.data ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchOverview()
      .then((res) => { if (!cancelled && res?.data) { setSnap(res.data); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
    // fetchOverview is a stable module function (studentApi.overview / crApi.overview)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useTeacherConfirmationRefresh(snap?.todayClasses, () => {
    fetchOverview().then((res) => { if (res?.data) { setSnap(res.data); setFailed(false); } }).catch(() => {});
  }, path.startsWith('/api/cr/') ? 60000 : 0);
  return { snap, loaded: snap !== null, failed };
}

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
    <span className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/85">
      {children}
    </span>
  );
}

export function DashboardHero({ roleLabel, name, section, status, extraChips = [] }) {
  const now = usePkNow(true);
  const hour = Number(now.hm.split(':')[0]);
  const firstName = (name ?? '').split(' ')[0];

  return (
    <section className="relative overflow-hidden rounded-3xl border border-primary-700 bg-gradient-to-br from-primary-700 via-primary-600 to-primary-500 p-5 text-white shadow-lift sm:p-7">
      {/* CSS-only depth, no blur/filter or moving decoration on mobile. */}
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full border-[40px] border-white/5" />
      <span aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 size-48 rounded-full border-[32px] border-white/5" />
      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-white/90">{roleLabel}</span>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-primary-100">{pkDateLine()}</span>
          </div>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {greetingFor(hour)}{firstName ? `, ${firstName}` : ''}.
          </h2>
          <p className="mt-1 text-sm text-primary-100">Here’s your section overview for today.</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-white">
          <span className={`size-1.5 rounded-full ${status === 'active' ? 'bg-emerald-300' : 'bg-white/50'}`} />
          {status === 'active' ? 'Active section' : 'Section inactive'}
        </span>
      </div>
      <div className="relative mt-5 flex flex-wrap gap-1.5 border-t border-white/15 pt-4">
        {section?.name && <Chip>Section <span className="font-semibold text-white">{section.name}</span></Chip>}
        {section?.department?.name && <Chip>{section.department.name}</Chip>}
        {section?.semester != null && <Chip>Semester {section.semester}</Chip>}
        {extraChips}
      </div>
    </section>
  );
}

/** Quiet hierarchy label shared by both dashboards. */
export function DashboardSectionHeader({ title, description }) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-semibold tracking-tight text-slate-900">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
    </div>
  );
}

/**
 * Live-state class row — mirrors the timetable page's timeline states.
 * With `focusTo`, the whole row is a deep-link: tapping it opens the
 * timetable page scrolled to THAT slot with the blue focus ring (same
 * interaction language as notification taps).
 */
function ClassRow({ c, focusTo }) {
  const now = usePkNow(true);
  const ongoing = c.startTime <= now.hm && now.hm < c.endTime;
  const past = now.hm >= c.endTime;
  const inner = (
    <>
      <div className="shrink-0 text-right">
        <p className={`font-mono text-[13px] font-semibold leading-tight ${ongoing ? 'text-emerald-700' : past ? 'text-slate-400' : 'text-slate-800'}`}>
          {fmtTime(c.startTime)}
        </p>
        <p className={`mt-0.5 font-mono text-[10px] leading-tight ${past ? 'text-slate-300' : 'text-slate-400'}`}>{fmtTime(c.endTime)}</p>
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-medium ${past ? 'text-slate-400' : 'text-slate-800'}`}>{c.subject?.name ?? 'Class'}</p>
        <p className={`mt-0.5 truncate text-xs ${past ? 'text-slate-400' : 'text-slate-500'}`}>
          {c.subject?.code}{c.room ? ` · Room ${fmtRoom(c.room)}` : ''}
        </p>
        <div className="mt-1.5"><TeacherConfirmationStatus confirmation={c.teacherConfirmation} compact /></div>
      </div>
      {ongoing ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
          <span className="size-1.5 rounded-full bg-emerald-500 lg:animate-pulse" />
          Now
        </span>
      ) : focusTo && <IconArrowRight className="size-3.5 shrink-0 text-slate-300" />}
    </>
  );
  const surface = `flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
    ongoing
      ? 'border-emerald-200 bg-emerald-50/50 ring-1 ring-emerald-400/50'
      : 'border-slate-100 bg-slate-50/60'
  } ${focusTo ? 'cursor-pointer hover:border-slate-200 hover:bg-white' : ''}`;
  return (
    <li>
      {focusTo
        ? <Link to={`${focusTo}?focus=${c._id ?? ''}`} className={surface}>{inner}</Link>
        : <div className={surface}>{inner}</div>}
    </li>
  );
}

export function TodayClassesCard({ slots, loading, to, linkLabel, emptyText, focusTo, className = '' }) {
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
        {sorted.map((c) => <ClassRow key={c._id} c={c} focusTo={focusTo} />)}
      </ul>
    );
  }

  return (
    <Card className={`h-full p-5 sm:p-6 ${className}`}>
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

/** White icon chip used by feed rows — subtle ring gives depth on tinted rows. */
function FeedIcon({ Icon }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white text-primary-600 ring-1 ring-slate-200/80">
      <Icon className="size-4" />
    </span>
  );
}

/** Premium assignment row — icon chip, semibold title, status chip, meta line. */
export function AssignmentFeedRow({ title, subject, dueLine, chip, to }) {
  return (
    <Link to={to} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-200 hover:bg-white hover:shadow-soft [@media(hover:hover)]:active:scale-[0.99]">
      <FeedIcon Icon={IconClipboard} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p dir="auto" className="min-w-0 truncate text-sm font-semibold text-slate-800">{title}</p>
          {chip}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-slate-500">
          {subject ? `${subject} · ` : ''}{dueLine}
        </p>
      </div>
      <IconArrowRight className="mt-1 size-3.5 shrink-0 text-slate-300" aria-hidden="true" />
    </Link>
  );
}

/** Premium announcement row — icon chip, title + pinned badge, content, meta. */
export function AnnouncementFeedRow({ title, content, meta, pinned, to }) {
  const inner = (
    <>
      <FeedIcon Icon={IconMegaphone} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p dir="auto" className="min-w-0 line-clamp-2 break-words text-sm font-semibold text-slate-800">{title}</p>
          {pinned && <Badge variant="primary">Pinned</Badge>}
        </div>
        {content && <p dir="auto" className="mt-0.5 line-clamp-2 break-words text-[11px] leading-snug text-slate-500">{content}</p>}
        <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">{meta}</p>
      </div>
    </>
  );
  const surface = 'flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-200 hover:bg-white hover:shadow-soft [@media(hover:hover)]:active:scale-[0.99]';
  const withChevron = (
    <>
      {inner}
      <IconArrowRight className="mt-1 size-3.5 shrink-0 text-slate-300" aria-hidden="true" />
    </>
  );
  return to ? <Link to={to} className={surface}>{withChevron}</Link> : <div className={surface}>{inner}</div>;
}
