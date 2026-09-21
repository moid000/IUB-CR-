import { useMemo, useState } from 'react';
import useFocusHighlight from '../../hooks/useFocusHighlight.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { studentApi } from '../../api/student.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { PageHeader } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import NextClassCountdown from '../../components/shared/NextClassCountdown.jsx';
import { DayNav, SlotTimeline, TimelineSkeleton, usePkNow, pktToday, prettyDate } from '../../components/shared/TimetableDay.jsx';
import { IconCalendar } from '../../components/icons.jsx';

/**
 * Student timetable — read-only DAILY wall-clock slots in Pakistan time.
 * Times are displayed EXACTLY as the CR entered them (never converted).
 * Default view is today, with a live countdown and a schedule-style timeline.
 */
export default function StudentTimetablePage() {
  const { user } = useAuth();
  const section = user?.section;

  const [date, setDate] = useState(pktToday);
  const today = useMemo(() => pktToday(), []);
  const isToday = date === today;
  const now = usePkNow(isToday);

  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.timetable.list({ date, status: 'active', page: 1, limit: 100 }), [date],
    () => studentApi.timetable.cachedList({ date, status: 'active', page: 1, limit: 100 })
  );
  const { items: todaySlots, loading: todayLoading } = useAdminQuery(
    () => studentApi.timetable.list({ date: today, status: 'active', page: 1, limit: 100 }), [],
    () => studentApi.timetable.cachedList({ date: today, status: 'active', page: 1, limit: 100 })
  );

  const slots = useMemo(
    () => [...(items ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [items]
  );

  useFocusHighlight(slots);

  if (!section) return <NoSection />;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Timetable"
        description={`Daily class schedule for Section ${section.name}. Times shown in Pakistan Standard Time.`}
      />

      {isToday && <NextClassCountdown slots={todaySlots} loading={todayLoading} />}

      <DayNav date={date} onChange={setDate} today={today} />

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <TimelineSkeleton rows={Math.min(todaySlots?.length || 4, 5)} />
      ) : slots.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconCalendar className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">No classes scheduled for {prettyDate(date)}.</h3>
          <p className="mt-1 text-sm text-slate-500">{isToday ? 'Your CR will publish today\'s schedule here.' : 'Your CR didn\'t schedule any classes for this day.'}</p>
        </div>
      ) : (
        <section aria-label={`Classes on ${prettyDate(date)}`}>
          <div className="mb-2.5 flex items-center justify-between px-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {slots.length} {slots.length === 1 ? 'class' : 'classes'}
            </h3>
            {isToday && slots.length > 0 && (
              <span className="text-[11px] text-slate-400">Live status</span>
            )}
          </div>
          <SlotTimeline slots={slots} isToday={isToday} now={now} />
        </section>
      )}
    </div>
  );
}
