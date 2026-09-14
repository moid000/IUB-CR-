/**
 * Single source of truth for "now" in deadline enforcement.
 *
 * Production: real server UTC time. Tests: may pin `MOCK_NOW` (epoch ms) for
 * deterministic before/at/after-deadline checks — same process as the app in
 * the test suite. The deadline rule itself ALWAYS lives server-side:
 * eligible iff now() <= assignment.deadline (UTC comparison).
 */
export function now() {
  const mock = Number.parseInt(process.env.MOCK_NOW, 10);
  return Number.isFinite(mock) ? mock : Date.now();
}

export const nowDate = () => new Date(now());

/**
 * Asia/Karachi wall clock derived from now(). Pakistan is UTC+5 year-round
 * (no DST) — a fixed offset is exact and avoids timezone database dependency.
 * Timetable slots store Karachi-local day + HH:MM wall-clock strings, so
 * reminder matching and dedupe dates MUST be computed in Karachi local time,
 * never UTC (a 01:00 PKT Monday class is 20:00 UTC Sunday).
 */
const KHI_OFFSET_MS = 5 * 60 * 60 * 1000;

const KHI_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function karachiWallClock(epoch = now()) {
  const d = new Date(epoch + KHI_OFFSET_MS); // read via UTC getters = Karachi wall time
  const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD, Karachi-local
  const dayName = KHI_DAYS[d.getUTCDay()];
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { dateStr, dayName, minutes };
}

/** Karachi-local date key (YYYY-MM-DD) for a given instant. */
export const karachiDateKey = (epoch = now()) => karachiWallClock(epoch).dateStr;
