import { useMemo } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { studentApi } from '../../api/student.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { PageHeader } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import { IconCalendar, IconClock } from '../../components/icons.jsx';

const DAYS = [
  { value: 'monday', label: 'Mon' },
  { value: 'tuesday', label: 'Tue' },
  { value: 'wednesday', label: 'Wed' },
  { value: 'thursday', label: 'Thu' },
  { value: 'friday', label: 'Fri' },
  { value: 'saturday', label: 'Sat' },
];

const TZ = 'Asia/Karachi';

function todayKey() {
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: TZ })
    .format(new Date()).toLowerCase();
  return DAYS.some((d) => d.value === day) ? day : null;
}

/**
 * Student timetable — read-only weekly wall-clock slots in Pakistan time.
 * Times are displayed EXACTLY as the CR entered them (never converted).
 */
export default function StudentTimetablePage() {
  const { user } = useAuth();
  const section = user?.section;
  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.timetable.list({ status: 'active', page: 1, limit: 100 }),
    []
  );

  const today = useMemo(() => todayKey(), []);

  const byDay = useMemo(() => {
    const map = Object.fromEntries(DAYS.map((d) => [d.value, []]));
    items.forEach((s) => { if (map[s.day]) map[s.day].push(s); });
    DAYS.forEach((d) => map[d.value].sort((a, b) => a.startTime.localeCompare(b.startTime)));
    return map;
  }, [items]);

  if (!section) return <NoSection />;

  const total = items.length;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Timetable"
        description={`Weekly class schedule for Section ${section.name}. Times shown in Pakistan Standard Time.`}
      />

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading timetable">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-2xl border border-slate-200/60 bg-slate-100/60" />
          ))}
        </div>
      ) : total === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconCalendar className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">No timetable entries yet.</h3>
          <p className="mt-1 text-sm text-slate-500">Your CR hasn't published the class schedule.</p>
        </div>
      ) : (
        <>
          {/* ---- Desktop: weekly grid ---- */}
          <div className="hidden gap-3 lg:grid lg:grid-cols-6">
            {DAYS.map(({ value, label }) => (
              <div key={value} className={`rounded-2xl border bg-white p-3 shadow-soft ${value === today ? 'border-primary-200 ring-1 ring-primary-100' : 'border-slate-200/80'}`}>
                <p className={`px-1 pb-2 text-xs font-semibold uppercase tracking-wide ${value === today ? 'text-primary-700' : 'text-slate-400'}`}>
                  {label}{value === today ? ' · Today' : ''}
                </p>
                <div className="space-y-2">
                  {byDay[value].length === 0 ? (
                    <p className="px-1 py-3 text-xs text-slate-400">No classes</p>
                  ) : byDay[value].map((s) => (
                    <div key={s._id} className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
                      <p className="truncate text-xs font-semibold text-slate-800">{s.subject?.name ?? 'Class'}</p>
                      <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-slate-500">
                        <IconClock className="size-3" />{s.startTime}–{s.endTime}
                      </p>
                      {s.room && <p className="mt-0.5 text-[11px] text-slate-400">Room {s.room}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* ---- Mobile/tablet: stacked day cards ---- */}
          <div className="space-y-3 lg:hidden">
            {DAYS.map(({ value, label }) => (
              <details key={value} open={value === today} className="rounded-2xl border border-slate-200/80 bg-white shadow-soft">
                <summary className={`flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-semibold ${value === today ? 'text-primary-700' : 'text-slate-700'}`}>
                  <span>{value === today ? `${label} · Today` : label}</span>
                  <Badge variant={byDay[value].length ? 'neutral' : 'gray'}>
                    {byDay[value].length} {byDay[value].length === 1 ? 'class' : 'classes'}
                  </Badge>
                </summary>
                <div className="space-y-2 px-4 pb-4">
                  {byDay[value].length === 0 ? (
                    <p className="py-2 text-sm text-slate-400">No classes</p>
                  ) : byDay[value].map((s) => (
                    <div key={s._id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-3.5 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-800">{s.subject?.name ?? 'Class'}</p>
                        {s.room && <p className="text-xs text-slate-500">Room {s.room}</p>}
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-slate-600">
                        <IconClock className="size-3.5 text-slate-400" />{s.startTime}–{s.endTime}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
