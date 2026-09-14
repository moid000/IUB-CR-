import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { formatDate, formatDateTime, timeAgo } from '../../admin/format.js';
import { Badge } from '../../components/ui/Badge.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import {
  IconUsers, IconBook, IconClipboard, IconCalendar, IconBell, IconMegaphone,
  IconClock, IconArrowRight,
} from '../../components/icons.jsx';

const TZ = 'Asia/Karachi';

function StatCard({ to, icon: Icon, label, value, hint }) {
  return (
    <Link
      to={to}
      className="group rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft transition-shadow hover:shadow-lift"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
        <Icon className="size-4 text-primary-500" />
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Link>
  );
}

export default function CrOverview() {
  const { user } = useAuth();
  const section = user?.section;

  // Today's weekday in Pakistan time (timetable is sunday-free)
  const today = useMemo(() => {
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: TZ })
      .format(new Date()).toLowerCase();
    return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].includes(day) ? day : null;
  }, []);

  const [counts, setCounts] = useState({ students: null, subjects: null, assignments: null, unread: null });
  const [recent, setRecent] = useState({ announcements: [], assignments: [], todayClasses: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!section) return undefined;
    let cancelled = false;
    const safe = (p) => p.catch(() => null);
    (async () => {
      const [students, subjects, assignments, unread, announcements, upcoming, timetable] = await Promise.all([
        safe(crApi.students.list({ limit: 1 })),
        safe(crApi.subjects.list({ status: 'active', limit: 1 })),
        safe(crApi.assignments.list({ status: 'published', limit: 5 })),
        safe(crApi.notifications.unreadCount()),
        safe(crApi.announcements.list({ status: 'published', limit: 4 })),
        safe(crApi.assignments.list({ status: 'published', limit: 4 })),
        today ? safe(crApi.timetable.list({ day: today, status: 'active', limit: 10 })) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setCounts({
        students: students?.pagination?.total ?? null,
        subjects: subjects?.pagination?.total ?? null,
        assignments: assignments?.pagination?.total ?? null,
        unread: unread?.data?.count ?? null,
      });
      setRecent({
        announcements: announcements?.data ?? [],
        assignments: upcoming?.data ?? [],
        todayClasses: timetable?.data ?? [],
      });
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [section, today]);

  if (!section) return <NoSection />;

  if (error) {
    return <Alert variant="danger">{error.message}</Alert>;
  }

  const firstName = (user?.name ?? '').split(' ')[0];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* ---- Greeting ---- */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Badge variant="primary">Class Representative</Badge>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
              Welcome back{firstName ? `, ${firstName}` : ''} 👋
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Managing <span className="font-medium text-slate-700">{section.name}</span>
              {section.department?.name ? ` · ${section.department.name}` : ''}
              {section.semester != null ? ` · Semester ${section.semester}` : ''}
            </p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium
            ${section.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
            <span className={`size-1.5 rounded-full ${section.status === 'active' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            Section {section.status}
          </span>
        </div>
      </div>

      {/* ---- Metric cards (real backend counts only) ---- */}
      {!loaded ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl border border-slate-200/60 bg-slate-100/60" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
          <StatCard to="/cr/students" icon={IconUsers} label="Students" value={counts.students ?? '—'} />
          <StatCard to="/cr/subjects" icon={IconBook} label="Subjects" value={counts.subjects ?? '—'} />
          <StatCard to="/cr/assignments" icon={IconClipboard} label="Assignments" value={counts.assignments ?? '—'} />
          <StatCard to="/cr/timetable" icon={IconCalendar} label="Today's classes" value={recent.todayClasses.length} hint={today ? `on ${today}` : 'no classes on Sunday'} />
          <StatCard to="/cr/notifications" icon={IconBell} label="Unread" value={counts.unread ?? 0} hint="notifications" />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---- Today's timetable ---- */}
        <Card className="p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Today's timetable</h3>
            <Link to="/cr/timetable" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
              Manage <IconArrowRight className="size-3.5" />
            </Link>
          </div>
          {!loaded ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />)}</div>
          ) : recent.todayClasses.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
              {today ? 'No classes scheduled for today.' : 'No classes are scheduled on Sundays.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {recent.todayClasses.map((t) => (
                <li key={t._id} className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3.5 py-2.5">
                  <IconClock className="size-4 shrink-0 text-primary-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{t.subject?.name ?? '—'}</p>
                    <p className="text-xs text-slate-500">{t.room ? `Room ${t.room} · ` : ''}{t.subject?.code}</p>
                  </div>
                  <span className="shrink-0 font-mono text-xs font-semibold text-slate-700">
                    {t.startTime}–{t.endTime}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ---- Recent announcements ---- */}
        <Card className="p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Recent announcements</h3>
            <Link to="/cr/announcements" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
              All announcements <IconArrowRight className="size-3.5" />
            </Link>
          </div>
          {!loaded ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />)}</div>
          ) : recent.announcements.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">No announcements yet.</p>
          ) : (
            <ul className="space-y-2">
              {recent.announcements.map((a) => (
                <li key={a._id} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3.5 py-2.5">
                  <IconMegaphone className="mt-0.5 size-4 shrink-0 text-primary-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{a.title}</p>
                    <p className="text-xs text-slate-500">{a.author?.name ?? 'CR'} · {timeAgo(a.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ---- Open assignments ---- */}
      <Card className="p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Latest assignments</h3>
          <Link to="/cr/assignments" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
            Manage assignments <IconArrowRight className="size-3.5" />
          </Link>
        </div>
        {!loaded ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />)}</div>
        ) : recent.assignments.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">No assignments created yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recent.assignments.map((a) => (
              <li key={a._id} className="flex flex-wrap items-center gap-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{a.title}</p>
                  <p className="text-xs text-slate-500">{a.subject?.name ?? '—'}</p>
                </div>
                <span className={`text-xs font-medium ${a.deadlinePassed ? 'text-red-600' : 'text-slate-600'}`}>
                  Due {formatDate(a.deadline)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
