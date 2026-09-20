import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
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
import { DashboardHero, TodayClassesCard, DueChip, Chip, AssignmentFeedRow, AnnouncementFeedRow, useOverviewData } from '../../components/shared/OverviewBits.jsx';
import {
  IconUsers, IconBook, IconClipboard, IconCalendar, IconBell, IconMegaphone,
  IconArrowRight,
} from '../../components/icons.jsx';

const TZ = 'Asia/Karachi';
const todayLabelFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });



export default function CrOverview() {
  const { user } = useAuth();
  const section = user?.section;

  const todayLabel = useMemo(() => todayLabelFmt.format(new Date()), []);

  // ONE aggregate request + SWR: last snapshot paints instantly, network
  // revalidates silently in the background (revisits feel 0ms)
  const { snap, loaded, failed } = useOverviewData('/api/cr/overview', crApi.overview);
  const counts = snap?.counts ?? {};
  const recent = useMemo(() => {
    const d = snap ?? {};
    return { announcements: d.announcements ?? [], assignments: d.assignments ?? [], todayClasses: d.todayClasses ?? [] };
  }, [snap]);

  if (!section) return <NoSection />;

  if (failed && !snap) {
    return <Alert variant="danger">Couldn't load your dashboard. Check your connection and try again.</Alert>;
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
          <StatCard to="/cr/students" icon={IconUsers} label="Students" value={counts.students ?? '—'} />
          <StatCard to="/cr/subjects" icon={IconBook} label="Subjects" value={counts.subjects ?? '—'} />
          <StatCard to="/cr/assignments" icon={IconClipboard} label="Assignments" value={counts.assignments ?? '—'} />
          <StatCard to="/cr/timetable" icon={IconCalendar} label="Classes today" value={recent.todayClasses.length} hint={`on ${todayLabel}`} />
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
          <div className="space-y-2">
            {recent.announcements.map((a) => (
              <AnnouncementFeedRow
                key={a._id}
                to="/cr/announcements"
                title={a.title}
                pinned={a.pinned}
                meta={`${a.author?.name ?? 'CR'} · ${timeAgo(a.createdAt)}`}
              />
            ))}
          </div>
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
          <div className="space-y-2">
            {recent.assignments.map((a) => (
              <AssignmentFeedRow
                key={a._id}
                to="/cr/assignments"
                title={a.title}
                subject={a.subject?.name}
                dueLine={`Due ${formatDateTime(a.deadline)}`}
                chip={<DueChip deadline={a.deadline} passed={a.deadlinePassed} />}
              />
            ))}
          </div>
        )}
      </Card>

      {/* ---- Device notifications (action, last) ---- */}
      <PushSetupCard variant="cr" />
    </div>
  );
}
