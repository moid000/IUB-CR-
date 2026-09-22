import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { studentApi } from '../../api/student.js';
import { formatDateTime, timeAgo } from '../../admin/format.js';
import { Badge } from '../../components/ui/Badge.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { StatCard } from '../../components/ui/StatCard.jsx';
import { MiniEmpty } from '../../components/ui/MiniEmpty.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import NextClassCountdown from '../../components/shared/NextClassCountdown.jsx';
import { PushSetupCard } from '../../components/shared/PushSetupCard.jsx';
import {
  DashboardHero, DashboardSectionHeader, TodayClassesCard, DueChip, Chip,
  AssignmentFeedRow, AnnouncementFeedRow, useOverviewData,
} from '../../components/shared/OverviewBits.jsx';
import {
  IconBook, IconClipboard, IconCalendar, IconBell, IconQr, IconArrowRight,
  IconCheckCircle, IconMegaphone,
} from '../../components/icons.jsx';

const TZ = 'Asia/Karachi';
const todayLabelFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });

/** Student command centre. Every metric is real backend data; SWR paints the
 * last snapshot immediately and silently refreshes it in the background. */
export default function StudentOverview() {
  const { user } = useAuth();
  const section = user?.section;
  const todayLabel = useMemo(() => todayLabelFmt.format(new Date()), []);
  const { snap, loaded } = useOverviewData('/api/student/overview', studentApi.overview);
  const counts = snap?.counts ?? {};
  const recent = useMemo(() => {
    const d = snap ?? {};
    const upcoming = (d.assignments ?? [])
      .filter((a) => !a.deadlinePassed)
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
    return { announcements: d.announcements ?? [], assignments: upcoming, todayClasses: d.todayClasses ?? [] };
  }, [snap]);

  if (!section) return <NoSection />;

  return (
    <div className="mx-auto max-w-6xl space-y-7 sm:space-y-8">
      <DashboardHero
        roleLabel="Student"
        name={user?.name}
        section={section}
        status={section.status}
        extraChips={user?.rollNo ? [<Chip key="roll">Roll no. {user.rollNo}</Chip>] : []}
      />

      <section aria-label="Academic overview">
        <DashboardSectionHeader title="At a glance" description="Your current section activity and progress." />
        {!loaded ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className={`h-[112px] skeleton-shimmer rounded-2xl border border-slate-200/60 ${i === 4 ? 'col-span-2 lg:col-span-1' : ''}`} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
            <StatCard to="/student/subjects" icon={IconBook} label="Subjects" value={counts.subjects ?? '—'} />
            <StatCard to="/student/assignments" icon={IconClipboard} label="Assignments" value={counts.assignments ?? '—'} hint="published for your section" />
            <StatCard to="/student/timetable" icon={IconCalendar} label="Classes today" value={recent.todayClasses.length} hint={`on ${todayLabel}`} />
            <StatCard to="/student/attendance" icon={IconQr} label="Attendance" value={counts.attendance ?? '—'} hint="sessions attended" />
            <StatCard to="/student/notifications" icon={IconBell} label="Unread notifications" value={counts.unread ?? 0} hint="open notification centre" wideMobile className="col-span-2 lg:col-span-1" />
          </div>
        )}
      </section>

      <section aria-label="Today's schedule">
        <DashboardSectionHeader title="Today" description="Your next class and complete schedule for the day." />
        <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
          <NextClassCountdown slots={recent.todayClasses} loading={!loaded} />
          <TodayClassesCard
            slots={recent.todayClasses}
            loading={!loaded}
            to="/student/timetable"
            focusTo="/student/timetable"
            linkLabel="Full timetable"
            emptyText="No classes scheduled for today — your CR / GR publishes the daily schedule."
          />
        </div>
      </section>

      <section aria-label="Latest updates">
        <DashboardSectionHeader title="Latest" description="Upcoming deadlines and recent section announcements." />
        <div className="grid items-stretch gap-4 lg:grid-cols-2">
          <Card className="h-full p-5 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Upcoming assignments</h3>
              <Link to="/student/assignments" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
                View all <IconArrowRight className="size-3.5" />
              </Link>
            </div>
            <div className="mt-4 space-y-2">
              {!loaded ? (
                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 skeleton-shimmer rounded-xl" />)}</div>
              ) : recent.assignments.length === 0 ? (
                <MiniEmpty icon={IconCheckCircle} text="No upcoming deadlines — you're all caught up." />
              ) : recent.assignments.map((a) => (
                <AssignmentFeedRow
                  key={a._id}
                  to={`/student/assignments?focus=${a._id}`}
                  title={a.title}
                  subject={a.subject?.name}
                  dueLine={`Due ${formatDateTime(a.deadline)}`}
                  chip={a.mySubmission ? <Badge variant="success">Submitted</Badge> : <DueChip deadline={a.deadline} passed={a.deadlinePassed} />}
                />
              ))}
            </div>
          </Card>

          <Card className="h-full p-5 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Recent announcements</h3>
              <Link to="/student/announcements" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
                View all <IconArrowRight className="size-3.5" />
              </Link>
            </div>
            <div className="mt-4 space-y-2">
              {!loaded ? (
                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 skeleton-shimmer rounded-xl" />)}</div>
              ) : recent.announcements.length === 0 ? (
                <MiniEmpty icon={IconMegaphone} text="No announcements yet — your CR / GR posts will appear here." />
              ) : recent.announcements.map((a) => (
                <AnnouncementFeedRow
                  key={a._id}
                  to={`/student/announcements?focus=${a._id}`}
                  title={a.title}
                  content={a.content}
                  pinned={a.pinned}
                  meta={`${a.author?.name ?? 'CR'} · ${timeAgo(a.createdAt)}`}
                />
              ))}
            </div>
          </Card>
        </div>
      </section>

      <PushSetupCard variant="student" />
    </div>
  );
}
