import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button.jsx';
import { IconBell, IconClock } from '../icons.jsx';

/**
 * Next-class countdown + 30-minute alert.
 *
 * Timetable slots are PKT wall-clock strings (date YYYY-MM-DD, HH:MM).
 * This widget converts BOTH the current instant and the slot times into
 * the same comparable representation — "PKT wall clock read as if UTC" —
 * so the math never mixes real UTC with wall-clock data.
 *
 * States: no classes today · upcoming (>30 min) · ALERT (within 30 min,
 * live mm:ss countdown, one browser Notification per slot + vibration) ·
 * class in progress · all done.
 */
const TZ = 'Asia/Karachi';
const ALERT_WINDOW_MS = 30 * 60 * 1000;

/** Current instant as "PKT wall-clock read as UTC" — comparable with slotPoints(). */
function pktNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
}

function pktToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

/** Slot wall-clock (PKT) as the same "read as UTC" instant. */
function slotPoints(slot) {
  const [y, m, d] = slot.date.split('-').map(Number);
  const [sh, sm] = slot.startTime.split(':').map(Number);
  const [eh, em] = slot.endTime.split(':').map(Number);
  return {
    start: Date.UTC(y, m - 1, d, sh, sm),
    end: Date.UTC(y, m - 1, d, eh, em),
  };
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default function NextClassCountdown({ slots, loading = false }) {
  const [tick, setTick] = useState(() => Date.now());
  const [perm, setPerm] = useState(() =>
    (typeof Notification === 'undefined') ? 'unsupported' : Notification.permission);
  const notifiedRef = useRef(new Set());

  const today = useMemo(() => pktToday(), []);
  const live = useMemo(() => pktNow(), [tick]);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const todaySlots = useMemo(
    () => (slots ?? []).filter((s) => s.date === today)
      .sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [slots, today]
  );

  const state = useMemo(() => {
    for (const slot of todaySlots) {
      const { start, end } = slotPoints(slot);
      if (live >= start && live < end) return { mode: 'ongoing', slot, end, start };
      if (live < start) return { mode: 'upcoming', slot, start };
    }
    return { mode: 'done' };
  }, [todaySlots, live]);

  // exactly one browser notification + vibration when a slot enters the 30-min window
  useEffect(() => {
    if (state.mode !== 'upcoming' || state.start - live > ALERT_WINDOW_MS || state.start - live <= 0) return;
    const key = `${state.slot._id}:${today}`;
    if (notifiedRef.current.has(key)) return;
    notifiedRef.current.add(key);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('Class starting soon!', {
          body: `${state.slot.subject?.name ?? 'Class'} starts at ${state.slot.startTime}${state.slot.room ? ` — Room ${state.slot.room}` : ''}`,
          tag: `iubcr-class-${state.slot._id}`,
        });
      } catch { /* some browsers throw on construction — non-fatal */ }
    }
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }, [state.mode, state.start, state.slot, live, today]);

  const requestPermission = async () => {
    if (typeof Notification === 'undefined') return;
    try { setPerm(await Notification.requestPermission()); } catch { /* non-fatal */ }
  };

  const name = (slot) => slot?.subject?.name ?? 'Class';

  let body;
  if (loading) {
    body = <p className="py-2 text-sm text-slate-400">Loading today's classes…</p>;
  } else if (state.mode === 'ongoing') {
    body = (
      <>
        <div className="flex items-center gap-2">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
          </span>
          <p className="text-sm font-semibold text-slate-900">
            {name(state.slot)} chal rahi hai{state.slot.room ? ` — Room ${state.slot.room}` : ''}
          </p>
        </div>
        <p className="mt-1 text-xs text-slate-500">Ends at {state.slot.endTime} · {fmtCountdown(state.end - live)} left</p>
      </>
    );
  } else if (state.mode === 'upcoming' && state.start - live <= ALERT_WINDOW_MS) {
    body = (
      <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="inline-flex items-center gap-2 text-sm font-semibold text-amber-900">
            <IconBell className="size-4 animate-pulse" />
            {name(state.slot)} — <span className="font-mono">{fmtCountdown(state.start - live)}</span> mein start
          </p>
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">30-min alert</span>
        </div>
        <p className="mt-1 text-xs text-amber-800/80">
          Starts {state.slot.startTime} · ends {state.slot.endTime}{state.slot.room ? ` · Room ${state.slot.room}` : ''}
        </p>
      </>
    );
  } else if (state.mode === 'upcoming') {
    body = (
      <>
        <p className="text-sm font-semibold text-slate-900">Next class: {name(state.slot)} at {state.slot.startTime}</p>
        <p className="mt-1 text-xs text-slate-500">{fmtCountdown(state.start - live)} to go{state.slot.room ? ` · Room ${state.slot.room}` : ''}</p>
      </>
    );
  } else if (todaySlots.length === 0) {
    body = <p className="text-sm text-slate-500">No classes scheduled for today yet — your CR updates the timetable.</p>;
  } else {
    body = <p className="text-sm text-slate-500">All of today's classes are done.</p>;
  }

  const isAlert = state.mode === 'upcoming' && state.start - live <= ALERT_WINDOW_MS;

  return (
    <section
      aria-label="Next class countdown"
      className={`rounded-2xl border p-4 shadow-soft ${
        isAlert
          ? 'border-amber-300 bg-amber-50'
          : state.mode === 'ongoing'
            ? 'border-emerald-200 bg-emerald-50/60'
            : 'border-slate-200/80 bg-white'
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <IconClock className="size-3.5" /> Today · {today}
        </h3>
        {perm === 'default' && <Button variant="secondary" size="sm" onClick={requestPermission}>Enable alerts</Button>}
      </div>
      {body}
    </section>
  );
}
