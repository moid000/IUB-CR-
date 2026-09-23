import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { formatDateTime, timeAgo } from '../../admin/format.js';
import { Card } from '../../components/ui/Card.jsx';
import { StatCard } from '../../components/ui/StatCard.jsx';
import { MiniEmpty } from '../../components/ui/MiniEmpty.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import NextClassCountdown from '../../components/shared/NextClassCountdown.jsx';
import { PushSetupCard } from '../../components/shared/PushSetupCard.jsx';
import {
  DashboardHero, DashboardSectionHeader, TodayClassesCard, DueChip, Chip,
  AssignmentFeedRow, AnnouncementFeedRow, useOverviewData,
} from '../../components/shared/OverviewBits.jsx';
import {
  IconUsers, IconBook, IconClipboard, IconCalendar, IconBell, IconMegaphone, IconArrowRight,
} from '../../components/icons.jsx';

const TZ = 'Asia/Karachi';
const todayLabelFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });

export default function CrOverview() {
  const { user } = useAuth();
  const section = user?.section;
  const todayLabel = useMemo(() => todayLabelFmt.format(new Date()), []);
  const { snap, loaded, failed } = useOverviewData('/api/cr/overview', crApi.overview);
  const counts = snap?.counts ?? {};
  const recent = useMemo(() => {
    const d = snap ?? {};
    return { announcements: d.announcements ?? [], assignments: d.assignments ?? [], todayClasses: d.todayClasses ?? [] };
  }, [snap]);

  if (!section) return <NoSection />;
  if (failed && !snap) return <Alert variant="danger">Couldn't load your dashboard. Check your connection and try again.</Alert>;

  return (
    <div className="mx-auto max-w-6xl space-y-7 sm:space-y-8">
      <DashboardHero
        roleLabel={user?.role === 'GR' ? 'General Representative' : 'Class Representative'}
        name={user?.name}
        section={section}
        status={section.status}
        extraChips={user?.rollNo ? [<Chip key="roll">Roll no. {user.rollNo}</Chip>] : []}
      />

      <section aria-label="Section overview">
        <DashboardSectionHeader title="At a glance" description="Live activity across your section workspace." />
        {!loaded ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className={`h-[112px] skeleton-shimmer rounded-2xl border border-slate-200/60 ${i === 4 ? 'col-span-2 lg:col-span-1' : ''}`} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
            <StatCard to="/cr/students" icon={IconUsers} label="Students" value={counts.students ?? '—'} />
            <StatCard to="/cr/subjects" icon={IconBook} label="Subjects" value={counts.subjects ?? '—'} />
            <StatCard to="/cr/assignments" icon={IconClipboard} label="Assignments" value={counts.assignments ?? '—'} />
            <StatCard to="/cr/timetable" icon={IconCalendar} label="Classes today" value={recent.todayClasses.length} hint={`on ${todayLabel}`} />
            <StatCard to="/cr/notifications" icon={IconBell} label="Unread notifications" value={counts.unread ?? 0} hint="open notification centre" wideMobile className="col-span-2 lg:col-span-1" />
          </div>
        )}
      </section>

      <section aria-label="Today's schedule">
        <DashboardSectionHeader title="Today" description="Your next class and the section's complete schedule." />
        <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
          <NextClassCountdown slots={recent.todayClasses} loading={!loaded} />
          <TodayClassesCard
            slots={recent.todayClasses}
            loading={!loaded}
            to="/cr/timetable"
            focusTo="/cr/timetable"
            linkLabel="Manage"
            emptyText="No classes scheduled for today — add your first slot from the timetable."
          />
        </div>
      </section>

      <section aria-label="Latest published content">
        <DashboardSectionHeader title="Latest" description="Assignments and announcements recently shared with your section." />
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-stretch gap-4 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
          <Card className="min-w-0 h-full p-5 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Latest assignments</h3>
              <Link to="/cr/assignments" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
                Manage <IconArrowRight className="size-3.5" />
              </Link>
            </div>
            <div className="mt-4 space-y-2">
              {!loaded ? (
                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 skeleton-shimmer rounded-xl" />)}</div>
              ) : recent.assignments.length === 0 ? (
                <MiniEmpty icon={IconClipboard} text="No assignments yet — publish one and your section is notified automatically." />
              ) : recent.assignments.map((a) => (
                <AssignmentFeedRow
                  key={a._id}
                  to={`/cr/assignments?focus=${a._id}`}
                  title={a.title}
                  subject={a.subject?.name}
                  dueLine={`Due ${formatDateTime(a.deadline)}`}
                  chip={<DueChip deadline={a.deadline} passed={a.deadlinePassed} />}
                />
              ))}
            </div>
          </Card>

          <Card className="min-w-0 h-full p-5 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Recent announcements</h3>
              <Link to="/cr/announcements" className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700">
                View all <IconArrowRight className="size-3.5" />
              </Link>
            </div>
            <div className="mt-4 space-y-2">
              {!loaded ? (
                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 skeleton-shimmer rounded-xl" />)}</div>
              ) : recent.announcements.length === 0 ? (
                <MiniEmpty icon={IconMegaphone} text="No announcements yet — everything you publish here reaches your section." />
              ) : recent.announcements.map((a) => (
                <AnnouncementFeedRow
                  key={a._id}
                  to={`/cr/announcements?focus=${a._id}`}
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

      <PushSetupCard variant="cr" />
    </div>
  );
}
