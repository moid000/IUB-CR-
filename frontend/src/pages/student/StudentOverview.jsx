import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { studentApi } from '../../api/student.js';
import { formatDate, formatDateTime, fmtRoom } from '../../admin/format.js';
import { Badge } from '../../components/ui/Badge.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { StatCard } from '../../components/ui/StatCard.jsx';
import { MiniEmpty } from '../../components/ui/MiniEmpty.jsx';
import { Stagger } from '../../components/motion/primitives.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import NextClassCountdown from '../../components/shared/NextClassCountdown.jsx';
import { PushSetupCard } from '../../components/shared/PushSetupCard.jsx';
import {
  IconBook, IconClipboard, IconCalendar, IconBell, IconQr,
  IconArrowRight, IconClock, IconMegaphone, IconCheckCircle,
} from '../../components/icons.jsx';

const TZ = 'Asia/Karachi';
const todayLabelFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });


/**
 * Student dashboard — every number comes from a REAL backend count. Nothing
 * is fabricated: if a value can't be derived it stays "—".
 */
export default function StudentOverview() {
  const { user } = useAuth();
  const section = user?.section;

  // Today's date in Pakistan time (daily timetable — any calendar date)
  const today = useMemo(() => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), []);
  const todayLabel = useMemo(() => todayLabelFmt.format(new Date()), []);

  const [counts, setCounts] = useState({ subjects: null, assignments: null, attendance: null, unread: null });
  const [recent, setRecent] = useState({ announcements: [], assignments: [], todayClasses: [] });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!section) return undefined;
    let cancelled = false;
    const safe = (p) => p.catch(() => null);
    (async () => {
      const [subjects, assignments, attendance, unread, announcements, upcoming, timetable] = await Promise.all([
        safe(studentApi.subjects.list({ status: 'active', limit: 1 })),
        safe(studentApi.assignments.list({ status: 'published', limit: 5 })),
        safe(studentApi.attendance.history({ limit: 1 })),
        safe(studentApi.notifications.unreadCount()),
        safe(studentApi.announcements.list({ limit: 4 })),
        safe(studentApi.assignments.list({ status: 'published', limit: 4 })),
        safe(studentApi.timetable.list({ date: today, status: 'active', limit: 10 })),
      ]);
      if (cancelled) return;
      setCounts({
        subjects: subjects?.pagination?.total ?? null,
        assignments: assignments?.pagination?.total ?? null,
        attendance: attendance?.pagination?.total ?? null,
        unread: unread?.data?.count ?? null,
      });
      // upcoming = soonest-deadline published assignments (server sorts by createdAt,
      // so order client-side by deadline — never by fabricated data)
      const upcomingItems = (upcoming?.data ?? [])
        .filter((a) => !a.deadlinePassed)
        .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
      setRecent({
        announcements: announcements?.data ?? [],
        assignments: upcomingItems,
        todayClasses: timetable?.data ?? [],
      });
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [section, today]);

  if (!section) return <NoSection />;

  const firstName = (user?.name ?? '').split(' ')[0];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* ---- Greeting + academic context ---- */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Badge variant="primary">Student</Badge>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
              Welcome back{firstName ? `, ${firstName}` : ''} 👋
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {section.department?.name ? `${section.department.name} · ` : ''}
              Section <span className="font-medium text-slate-700">{section.name}</span>
              {section.semester != null ? ` · Semester ${section.semester}` : ''}
              {user?.rollNo ? ` · Roll no. ${user.rollNo}` : ''}
            </p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium
            ${section.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
            <span className={`size-1.5 rounded-full ${section.status === 'active' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            Section {section.status}
          </span>
        </div>
      </div>

      {/* ---- Live countdown to next class (30-min alert) ---- */}
      <NextClassCountdown slots={recent.todayClasses} loading={!loaded} />

      {/* ---- Metric cards (real backend counts only) ---- */}
      {!loaded ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 skeleton-shimmer rounded-2xl border border-slate-200/60" />
          ))}
        </div>
      ) : (
        <Stagger className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
          <StatCard to="/student/subjects" icon={IconBook} label="Subjects" value={counts.subjects ?? '—'} />
          <StatCard to="/student/assignments" icon={IconClipboard} label="Assignments" value={counts.assignments ?? '—'} hint="published for your section" />
          <StatCard to="/student/timetable" icon={IconCalendar} label="Today's classes" value={recent.todayClasses.length} hint={`on ${todayLabel}`} />
          <StatCard to="/student/attendance" icon={IconQr} label="Attendance" value={counts.attendance ?? '—'} hint="sessions attended" />
          <StatCard to="/student/notifications" icon={IconBell} label="Unread" value={counts.unread ?? 0} hint="notifications" className="col-span-2 lg:col-span-1" />
        </Stagger>
      )}

            <PushSetupCard variant="student" />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ---- Today's timetable ---- */}
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Today's classes</h3>
            <Link to="/student/timetable" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
              Full timetable <IconArrowRight className="size-3.5" />
            </Link>
          </div>
          <div className="mt-3 space-y-2">
            {recent.todayClasses.length === 0 ? (
              <MiniEmpty icon={IconCalendar} text="No classes scheduled for today — your CR / GR publishes the daily schedule." />
            ) : recent.todayClasses.map((c) => (
              <div key={c._id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">{c.subject?.name ?? 'Class'}</p>
                  {c.room && <p className="text-xs text-slate-500">Room {fmtRoom(c.room)}</p>}
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-slate-600">
                  <IconClock className="size-3.5 text-slate-400" />
                  {c.startTime}–{c.endTime}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* ---- Upcoming assignments ---- */}
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Upcoming assignments</h3>
            <Link to="/student/assignments" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
              All assignments <IconArrowRight className="size-3.5" />
            </Link>
          </div>
          <div className="mt-3 space-y-2">
            {recent.assignments.length === 0 ? (
              <MiniEmpty icon={IconCheckCircle} text="No upcoming deadlines — you're all caught up." />
            ) : recent.assignments.map((a) => (
              <Link key={a._id} to="/student/assignments" className="block rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3 transition-colors hover:bg-slate-100/70">
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-sm font-medium text-slate-800">{a.title}</p>
                  {a.mySubmission
                    ? <Badge variant="success">Submitted</Badge>
                    : <Badge variant={a.deadlinePassed ? 'danger' : 'warning'}>{a.deadlinePassed ? 'Overdue' : 'Pending'}</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {a.subject?.name ? `${a.subject.name} · ` : ''}Due {formatDateTime(a.deadline)}
                </p>
              </Link>
            ))}
          </div>
        </Card>
      </div>

      {/* ---- Recent announcements ---- */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Recent announcements</h3>
          <Link to="/student/announcements" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
            View all <IconArrowRight className="size-3.5" />
            </Link>
        </div>
        <div className="mt-3 space-y-2">
          {recent.announcements.length === 0 ? (
            <MiniEmpty icon={IconMegaphone} text="No announcements yet — your CR / GR posts will appear here." />
          ) : recent.announcements.map((a) => (
            <div key={a._id} className="rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-slate-800">{a.title}</p>
                {a.pinned && <Badge variant="primary">Pinned</Badge>}
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{a.content}</p>
              <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-400">{formatDate(a.createdAt)}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
