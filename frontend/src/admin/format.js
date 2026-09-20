/** Date/time formatting — Asia/Karachi, consistent across the admin portal. */
const TZ = 'Asia/Karachi';

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ });

export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : dateTimeFmt.format(d);
}

/** Compact relative time for recency lists ("3h ago", "2d ago"). */
export function timeAgo(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

const dateTimeNoYearFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: TZ });

/** "Mon 14 Sep, 9:10 PM" — used for short-lived expiries like attendance sessions. */
export function formatDateTimeNoYear(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : dateTimeNoYearFmt.format(d);
}

/** Room labels are stored exactly as the CR typed them (often already "Room 12") —
 *  strip a redundant leading "Room" so the UI never shows "Room Room 12". */
export function fmtRoom(room) {
  if (!room) return '';
  return String(room).trim().replace(/^rooms?\s*[-–:.]?\s*/i, '');
}

/** "13:00" -> "1:00 PM" — slots are stored 24h "HH:MM"; users read 12-hour. */
export function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${hr}:${String(m ?? 0).padStart(2, '0')} ${ampm}`;
}

/** Milliseconds -> "1h 30m" (>=1h), "29m 45s" (<1h), "45s" (<1m). */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
