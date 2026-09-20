import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { studentApi } from '../../api/student.js';
import { formatDateTime, timeAgo } from '../../admin/format.js';
import { Badge } from '../../components/ui/Badge.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { StatCard } from '../../components/ui/StatCard.jsx';
import { MiniEmpty } from '../../components/ui/MiniEmpty.jsx';
import { Stagger } from '../../components/motion/primitives.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import NextClassCountdown from '../../components/shared/NextClassCountdown.jsx';
import { PushSetupCard } from '../../components/shared/PushSetupCard.jsx';
import { DashboardHero, TodayClassesCard, DueChip, Chip, AssignmentFeedRow, AnnouncementFeedRow } from '../../components/shared/OverviewBits.jsx';
import {
  IconBook, IconClipboard, IconCalendar, IconBell, IconQr, IconArrowRight, IconCheckCircle,
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

  return (
    <div className="mx-auto max-w-6xl space-y-5 sm:space-y-6">
      {/* ---- Greeting + academic context ---- */}
      <DashboardHero
        roleLabel="Student"
        name={user?.name}
        section={section}
        status={section.status}
        extraChips={user?.rollNo ? [<Chip key="roll">Roll no. {user.rollNo}</Chip>] : []}
      />

      {/* ---- Live countdown to next class (30-min alert) ---- */}
      <NextClassCountdown slots={recent.todayClasses} loading={!loaded} />

      {/* ---- Metric cards (real backend counts only) ---- */}
      {!loaded ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-[88px] skeleton-shimmer rounded-2xl border border-slate-200/60" />
          ))}
        </div>
      ) : (
        <Stagger className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
          <StatCard to="/student/subjects" icon={IconBook} label="Subjects" value={counts.subjects ?? '—'} />
          <StatCard to="/student/assignments" icon={IconClipboard} label="Assignments" value={counts.assignments ?? '—'} hint="published for your section" />
          <StatCard to="/student/timetable" icon={IconCalendar} label="Classes today" value={recent.todayClasses.length} hint={`on ${todayLabel}`} />
          <StatCard to="/student/attendance" icon={IconQr} label="Attendance" value={counts.attendance ?? '—'} hint="sessions attended" />
          <StatCard to="/student/notifications" icon={IconBell} label="Unread" value={counts.unread ?? 0} hint="notifications" className="col-span-2 lg:col-span-1" />
        </Stagger>
      )}

      {/* ---- Today's classes (live states) ---- */}
      <TodayClassesCard
        slots={recent.todayClasses}
        loading={!loaded}
        to="/student/timetable"
        linkLabel="Full timetable"
        emptyText="No classes scheduled for today — your CR / GR publishes the daily schedule."
      />

      {/* ---- Upcoming assignments ---- */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Upcoming assignments</h3>
          <Link to="/student/assignments" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
            All assignments <IconArrowRight className="size-3.5" />
          </Link>
        </div>
        <div className="mt-3 space-y-2">
          {!loaded ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 skeleton-shimmer rounded-xl" />)}
            </div>
          ) : recent.assignments.length === 0 ? (
            <MiniEmpty icon={IconCheckCircle} text="No upcoming deadlines — you're all caught up." />
          ) : recent.assignments.map((a) => (
            <AssignmentFeedRow
              key={a._id}
              to="/student/assignments"
              title={a.title}
              subject={a.subject?.name}
              dueLine={`Due ${formatDateTime(a.deadline)}`}
              chip={a.mySubmission
                ? <Badge variant="success">Submitted</Badge>
                : <DueChip deadline={a.deadline} passed={a.deadlinePassed} />}
            />
          ))}
        </div>
      </Card>

      {/* ---- Recent announcements ---- */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Recent announcements</h3>
          <Link to="/student/announcements" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
            View all <IconArrowRight className="size-3.5" />
          </Link>
        </div>
        <div className="mt-3 space-y-2">
          {!loaded ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 skeleton-shimmer rounded-xl" />)}
            </div>
          ) : recent.announcements.length === 0 ? (
            <MiniEmpty icon={IconMegaphone} text="No announcements yet — your CR / GR posts will appear here." />
          ) : recent.announcements.map((a) => (
            <AnnouncementFeedRow
              key={a._id}
              to="/student/announcements"
              title={a.title}
              content={a.content}
              pinned={a.pinned}
              meta={`${a.author?.name ?? 'CR'} · ${timeAgo(a.createdAt)}`}
            />
          ))}
        </div>
      </Card>

      {/* ---- Device notifications (action, last) ---- */}
      <PushSetupCard variant="student" />
    </div>
  );
}
