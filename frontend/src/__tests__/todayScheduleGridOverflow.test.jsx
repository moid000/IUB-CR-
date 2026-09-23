import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { renderToString } from 'react-dom/server';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import NextClassCountdown from '../components/shared/NextClassCountdown.jsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

/**
 * Owner screenshot 2026-09-23: the Dashboard "Today" section (alert card +
 * Today's classes card) spilled past the phone screen edge on mobile, while
 * the "Latest" section right below it (same page) did not. ROOT CAUSE: the
 * "Today" grid was plain `grid ... lg:grid-cols-[...]` with NO mobile
 * grid-template — the implicit single "auto" track sizes to the CONTENT'S
 * max-content width (the full unwrapped line length of a long room string
 * like "Maths -1.57 ,BBA Department"), not the viewport, so the grid track
 * (and the whole page) grew wider than the phone and horizontal-scrolled.
 * "Latest" already used `min-w-0 grid-cols-[minmax(0,1fr)]` for exactly this
 * reason (same bug class as the earlier StatCard/Timetable 1fr-blowout
 * fixes). Fix: give "Today" the identical mobile guard, plus break-words +
 * min-w-0 inside NextClassCountdown's own text rows as defense in depth.
 */
describe('dashboard "Today" grid cannot blow out past the viewport on mobile', () => {
  it.each([
    'pages/student/StudentOverview.jsx',
    'pages/cr/CrOverview.jsx',
  ])('%s constrains the Today grid the same way the Latest grid already is', (rel) => {
    const code = src(rel);
    const todaySection = code.slice(code.indexOf('aria-label="Today\'s schedule"'), code.indexOf('aria-label="Latest updates"'));
    expect(todaySection).toContain('grid min-w-0 grid-cols-[minmax(0,1fr)] items-stretch gap-4 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]');
  });
});

describe('NextClassCountdown never breaks out with a long CR-typed room string', () => {
  const longRoom = 'Maths -1.57 ,BBA Department Extra Long Wing Name That Keeps Going';
  // Same "PKT wall-clock read as UTC" trick NextClassCountdown itself uses,
  // so the fixture lands in today's PKT date regardless of sandbox TZ.
  const pktNowParts = () => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    return { y: g('year'), m: g('month'), d: g('day'), h: g('hour') % 24, min: g('minute') };
  };
  const slot = (offsetStartMin, durationMin) => {
    const now = pktNowParts();
    const base = Date.UTC(now.y, now.m - 1, now.d, now.h, now.min);
    const start = new Date(base + offsetStartMin * 60000);
    const end = new Date(start.getTime() + durationMin * 60000);
    const hm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    const dateStr = `${now.y}-${String(now.m).padStart(2, '0')}-${String(now.d).padStart(2, '0')}`;
    return { _id: 'x', date: dateStr, startTime: hm(start), endTime: hm(end),
      room: longRoom, subject: { name: 'AI' }, teacherConfirmation: { status: 'confirmed' } };
  };

  it.each([
    ['upcoming alert (<30min)', slot(20, 60)],
    ['ongoing', slot(-10, 60)],
    ['plain upcoming (>30min)', slot(120, 60)],
  ])('%s: long room text stays wrap-safe, never nowrap', (_label, s) => {
    const html = renderToString(<NextClassCountdown slots={[s]} loading={false} />);
    expect(html).toContain('BBA Department'); // sanity: the long room text actually rendered
    expect(html).not.toContain('whitespace-nowrap');
    // the outer card and its text rows must carry the overflow-safety classes
    expect(html).toContain('min-w-0');
    expect(html).toContain('break-words');
  });
});
