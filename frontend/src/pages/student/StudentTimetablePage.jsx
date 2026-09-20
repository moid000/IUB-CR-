import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { studentApi } from '../../api/student.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { PageHeader } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import NextClassCountdown from '../../components/shared/NextClassCountdown.jsx';
import { IconCalendar, IconClock, IconChevronLeft, IconChevronRight } from '../../components/icons.jsx';

const TZ = 'Asia/Karachi';

function pktToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function prettyDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Student timetable — read-only DAILY wall-clock slots in Pakistan time.
 * Times are displayed EXACTLY as the CR entered them (never converted).
 * Default view is today, with a live countdown to the next class.
 */
export default function StudentTimetablePage() {
  const { user } = useAuth();
  const section = user?.section;

  const [date, setDate] = useState(pktToday);
  const today = useMemo(() => pktToday(), []);
  const isToday = date === today;

  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.timetable.list({ date, status: 'active', page: 1, limit: 100 }), [date]
  );
  const { items: todaySlots, loading: todayLoading } = useAdminQuery(
    () => studentApi.timetable.list({ date: today, status: 'active', page: 1, limit: 100 }), []
  );

  const slots = useMemo(
    () => [...(items ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [items]
  );

  if (!section) return <NoSection />;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Timetable"
        description={`Daily class schedule for Section ${section.name}. Times shown in Pakistan Standard Time.`}
      />

      {isToday && <NextClassCountdown slots={todaySlots} loading={todayLoading} />}

      {/* ---- Date navigation ---- */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200/80 bg-white p-3 shadow-soft">
        <Button variant="secondary" size="sm" icon={IconChevronLeft} aria-label="Previous day" onClick={() => setDate((d) => shiftDate(d, -1))}>Prev</Button>
        <Input id="stt-date" type="date" value={date} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} className="max-w-44" aria-label="Timetable date" />
        <Button variant="secondary" size="sm" icon={IconChevronRight} aria-label="Next day" onClick={() => setDate((d) => shiftDate(d, 1))}>Next</Button>
        {!isToday && <Button variant="secondary" size="sm" onClick={() => setDate(pktToday())}>Today</Button>}
        <span className="ml-auto flex items-center gap-2">
          {isToday && <Badge variant="primary">Today</Badge>}
          <span className="text-sm font-medium text-slate-600">{prettyDate(date)}</span>
        </span>
      </div>

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <div className="space-y-3" role="status" aria-label="Loading timetable">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 skeleton-shimmer rounded-2xl border border-slate-200/60" />
          ))}
        </div>
      ) : slots.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconCalendar className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">No classes scheduled for {prettyDate(date)}.</h3>
          <p className="mt-1 text-sm text-slate-500">{isToday ? 'Your CR will publish today\'s schedule here.' : 'Your CR didn\'t schedule any classes for this day.'}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {slots.map((s) => (
            <li key={s._id} className="flex items-center justify-between rounded-2xl border border-slate-200/80 bg-white px-4 py-3.5 shadow-soft">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 flex-col items-center justify-center rounded-xl bg-primary-50 text-primary-700">
                  <IconClock className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-800">{s.subject?.name ?? 'Class'}</p>
                  <p className="text-xs text-slate-500">
                    {s.subject?.code}{s.room ? ` · Room ${fmtRoom(s.room)}` : ''}
                  </p>
                </div>
              </div>
              <span className="shrink-0 font-mono text-xs font-semibold text-slate-700">{s.startTime}–{s.endTime}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
