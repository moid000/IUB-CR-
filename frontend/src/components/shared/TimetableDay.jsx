import { useEffect, useMemo, useState } from 'react';
import { Input } from '../ui/Input.jsx';
import { IconChevronLeft, IconChevronRight } from '../icons.jsx';
import { fmtRoom, fmtTime } from '../../admin/format.js';

/**
 * Shared mobile-first timetable building blocks (Student + CR pages).
 * DayNav: professional date navigator — big centered date, step chevrons, a
 * scrollable 7-day strip (selected ±3) and a compact native date jump.
 * SlotTimeline: schedule-style timeline cards with live state on "today"
 * (ongoing class highlighted, past classes dimmed) — the look of a premium
 * calendar app, not a plain list.
 */

const TZ = 'Asia/Karachi';

export function pktToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

export function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function prettyDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

function prettyDateLong(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** Current PKT wall clock as { date: 'YYYY-MM-DD', hm: 'HH:MM' } (24h). */
function readPkNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${hour}:${parts.minute}` };
}

/** Ticking PKT clock, refreshed every 30s while `active` — powers the
 *  ongoing/past slot states without any backend change. */
export function usePkNow(active) {
  const [now, setNow] = useState(readPkNow);
  useEffect(() => {
    if (!active) return undefined;
    setNow(readPkNow());
    const id = setInterval(() => setNow(readPkNow()), 30000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/* ------------------------------ Day navigator ------------------------------ */

export function DayNav({ date, onChange, today }) {
  const isToday = date === today;

  const strip = useMemo(() => {
    const start = shiftDate(date, -3);
    return Array.from({ length: 7 }, (_, i) => shiftDate(start, i));
  }, [date]);

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-3 shadow-soft">
      {/* Big date + step chevrons */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-label="Previous day"
          onClick={() => onChange(shiftDate(date, -1))}
          className="grid size-9 shrink-0 place-items-center rounded-xl border border-slate-200/80 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800"
        >
          <IconChevronLeft className="size-4" />
        </button>
        <div className="min-w-0 text-center">
          <p className="truncate text-sm font-semibold text-slate-900">{prettyDateLong(date)}</p>
          {isToday ? (
            <p className="mt-0.5 text-[11px] font-medium text-primary-600">Today</p>
          ) : (
            <button
              type="button"
              onClick={() => onChange(today)}
              className="mt-0.5 text-[11px] font-medium text-primary-600 underline-offset-2 hover:underline"
            >
              Jump to today
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Next day"
          onClick={() => onChange(shiftDate(date, 1))}
          className="grid size-9 shrink-0 place-items-center rounded-xl border border-slate-200/80 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800"
        >
          <IconChevronRight className="size-4" />
        </button>
      </div>

      {/* 7-day strip (scrollable on narrow screens) */}
      <div
        className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Pick a day"
      >
        {strip.map((d) => {
          const [y, m, dd] = d.split('-').map(Number);
          const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, dd)));
          const selected = d === date;
          const chipToday = d === today;
          return (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(d)}
              className={`flex min-w-[46px] shrink-0 flex-col items-center gap-0.5 rounded-xl px-2.5 py-1.5 text-center transition-colors ${
                selected ? 'bg-primary-600 text-white shadow-soft' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <span className={`text-[10px] font-medium ${selected ? 'text-white/80' : 'text-slate-400'}`}>{weekday}</span>
              <span className="flex items-center gap-1 text-xs font-semibold">
                {dd}
                {chipToday && <span className={`size-1 rounded-full ${selected ? 'bg-white' : 'bg-primary-500'}`} />}
              </span>
            </button>
          );
        })}
      </div>

      {/* Jump to any date */}
      <div className="mt-3 border-t border-slate-100 pt-2.5">
        <Input
          id="tt-jump-date"
          type="date"
          value={date}
          onChange={(e) => { if (e.target.value) onChange(e.target.value); }}
          className="max-w-44 text-xs"
          aria-label="Jump to date"
        />
      </div>
    </div>
  );
}

/* ------------------------------ Slot timeline ------------------------------ */

function slotDuration(s) {
  const [sh, sm] = s.startTime.split(':').map(Number);
  const [eh, em] = s.endTime.split(':').map(Number);
  const mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/**
 * Schedule timeline. On "today" the slot matching the live PKT clock gets an
 * emerald "Now" treatment and finished classes dim — students see exactly
 * where the day stands. `renderActions(slot)` (CR only) renders the action
 * row inside each card.
 */
export function SlotTimeline({ slots, isToday, now, renderActions }) {
  const status = (s) => {
    if (!isToday) return 'upcoming';
    if (s.startTime <= now.hm && now.hm < s.endTime) return 'ongoing';
    if (now.hm >= s.endTime) return 'past';
    return 'upcoming';
  };

  return (
    <ol className="relative space-y-3">
      {slots.map((s) => {
        const st = status(s);
        const dur = slotDuration(s);
        return (
          <li
            key={s._id}
            className={`relative grid grid-cols-[64px_minmax(0,1fr)] gap-3 ${st === 'past' ? 'opacity-55' : ''}`}
          >
            {/* Time rail */}
            <div className="flex flex-col items-end justify-center pt-1 text-right">
              <span className={`text-[11px] font-semibold leading-tight ${st === 'ongoing' ? 'text-emerald-600' : 'text-slate-800'}`}>
                {fmtTime(s.startTime)}
              </span>
              <span className="mt-0.5 text-[10px] leading-tight text-slate-400">{fmtTime(s.endTime)}</span>
            </div>

            {/* Card */}
            <div
              className={
                st === 'ongoing'
                  ? 'relative rounded-2xl border border-emerald-200 bg-white p-3.5 shadow-soft ring-1 ring-emerald-400/60'
                  : 'relative rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-soft transition-shadow hover:shadow-lift'
              }
            >
              {/* Timeline dot, aligned to the time rail */}
              <span
                aria-hidden="true"
                className={`absolute left-0 top-4 grid -translate-x-[38px] place-items-center ${
                  st === 'ongoing' ? 'size-2.5 rounded-full bg-emerald-500 ring-4 ring-emerald-100' : 'size-2 rounded-full bg-slate-300'
                }`}
              />
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{s.subject?.name ?? 'Class'}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                    {s.subject?.code && (
                      <span className="rounded-md bg-primary-50 px-1.5 py-0.5 font-medium text-primary-700">{s.subject.code}</span>
                    )}
                    {s.room && (
                      <span className="inline-flex items-center gap-1">
                        <span aria-hidden="true">·</span>Room {fmtRoom(s.room)}
                      </span>
                    )}
                    {dur && (
                      <span className="inline-flex items-center gap-1">
                        <span aria-hidden="true">·</span>{dur}
                      </span>
                    )}
                  </div>
                </div>
                {st === 'ongoing' && (
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                    <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                    Now
                  </span>
                )}
              </div>
              {renderActions && <div className="mt-2.5">{renderActions(s)}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Timeline-shaped skeleton rows (same geometry as SlotTimeline). */
export function TimelineSkeleton({ rows = 4 }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading timetable">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3">
          <div className="flex flex-col items-end gap-1.5 pt-1">
            <div className="h-3 w-10 rounded skeleton-shimmer" />
            <div className="h-2 w-8 rounded skeleton-shimmer" />
          </div>
          <div className="h-16 rounded-2xl border border-slate-200/60 skeleton-shimmer" />
        </div>
      ))}
    </div>
  );
}
