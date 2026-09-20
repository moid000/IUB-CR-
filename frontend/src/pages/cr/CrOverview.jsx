import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { formatDateTime, timeAgo } from '../../admin/format.js';
import { Badge } from '../../components/ui/Badge.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { StatCard } from '../../components/ui/StatCard.jsx';
import { MiniEmpty } from '../../components/ui/MiniEmpty.jsx';
import { Stagger } from '../../components/motion/primitives.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import NextClassCountdown from '../../components/shared/NextClassCountdown.jsx';
import { PushSetupCard } from '../../components/shared/PushSetupCard.jsx';
import { DashboardHero, TodayClassesCard, DueChip } from '../../components/shared/OverviewBits.jsx';
import {
  IconUsers, IconBook, IconClipboard, IconCalendar, IconBell, IconMegaphone,
  IconArrowRight,
} from '../../components/icons.jsx';

const TZ = 'Asia/Karachi';
const todayLabelFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });



export default function CrOverview() {
  const { user } = useAuth();
  const section = user?.section;

  // Today's date in Pakistan time (daily timetable — any calendar date)
  const today = useMemo(() => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), []);
  const todayLabel = useMemo(() => todayLabelFmt.format(new Date()), []);

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
        safe(crApi.timetable.list({ date: today, status: 'active', limit: 10 })),
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
    <div className="mx-auto max-w-6xl space-y-5 sm:space-y-6">
      {/* ---- Greeting + academic context ---- */}
      <DashboardHero
        roleLabel={user?.role === 'GR' ? 'General Representative' : 'Class Representative'}
        name={user?.name}
        section={section}
        status={section.status}
      />

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
          <StatCard to="/cr/students" icon={IconUsers} label="Students" value={counts.students ?? '—'} />
          <StatCard to="/cr/subjects" icon={IconBook} label="Subjects" value={counts.subjects ?? '—'} />
          <StatCard to="/cr/assignments" icon={IconClipboard} label="Assignments" value={counts.assignments ?? '—'} />
          <StatCard to="/cr/timetable" icon={IconCalendar} label="Today's classes" value={recent.todayClasses.length} hint={`on ${todayLabel}`} />
          <StatCard to="/cr/notifications" icon={IconBell} label="Unread" value={counts.unread ?? 0} hint="notifications" className="col-span-2 lg:col-span-1" />
        </Stagger>
      )}


      {/* ---- Today's classes (live states) ---- */}
      <TodayClassesCard
        slots={recent.todayClasses}
        loading={!loaded}
        to="/cr/timetable"
        linkLabel="Manage"
        emptyText="No classes scheduled for today — add your first slot from the timetable."
      />

      {/* ---- Recent announcements ---- */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Recent announcements</h3>
          <Link to="/cr/announcements" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
            All announcements <IconArrowRight className="size-3.5" />
          </Link>
        </div>
        {!loaded ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 skeleton-shimmer rounded-xl" />)}</div>
        ) : recent.announcements.length === 0 ? (
          <MiniEmpty icon={IconMegaphone} text="No announcements yet — everything you publish here reaches your section." />
        ) : (
          <ul className="space-y-2">
            {recent.announcements.map((a) => (
              <li key={a._id} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3.5 py-3">
                <IconMegaphone className="mt-0.5 size-4 shrink-0 text-primary-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{a.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{a.author?.name ?? 'CR'} · {timeAgo(a.createdAt)}</p>
                </div>
                {a.pinned && <Badge variant="primary">Pinned</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ---- Open assignments ---- */}
      <Card className="p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Latest assignments</h3>
          <Link to="/cr/assignments" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
            Manage assignments <IconArrowRight className="size-3.5" />
          </Link>
        </div>
        {!loaded ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-10 skeleton-shimmer rounded-lg" />)}</div>
        ) : recent.assignments.length === 0 ? (
          <MiniEmpty icon={IconClipboard} text="No assignments yet — publish one and your section is notified automatically." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {recent.assignments.map((a) => (
              <li key={a._id} className="flex flex-wrap items-center gap-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{a.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{a.subject?.name ?? '—'} · Due {formatDateTime(a.deadline)}</p>
                </div>
                <DueChip deadline={a.deadline} passed={a.deadlinePassed} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ---- Device notifications (action, last) ---- */}
      <PushSetupCard variant="cr" />
    </div>
  );
}
