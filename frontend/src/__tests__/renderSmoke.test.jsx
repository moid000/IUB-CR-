/**
 * RENDER-SMOKE SUITE — the production-safety net.
 *
 * These tests render (server-side, no browser needed) every SHARED component
 * that pages build on, in every state a real user can hit. They exist to catch
 * render-time crashes (TDZ bugs, missing imports, undefined access on edge-case
 * data) BEFORE a deploy — the exact class of bug that once shipped a broken
 * dashboard to production.
 *
 * Rule: if a shared component used by any portal can render it, it renders here.
 */
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import NextClassCountdown from '../components/shared/NextClassCountdown.jsx';
import {
  DashboardHero, TodayClassesCard, DueChip, AssignmentFeedRow, AnnouncementFeedRow,
} from '../components/shared/OverviewBits.jsx';
import { DayNav, SlotTimeline } from '../components/shared/TimetableDay.jsx';
import { RouteErrorBoundary } from '../pages/ErrorBoundary.jsx';
import { fmtTime, fmtDuration } from '../admin/format.js';

const R = (ui) => renderToString(<MemoryRouter>{ui}</MemoryRouter>);

// PKT clock is frozen at a fixed moment via a controllable slot set instead:
// slots are crafted relative to "now" so at least one is past / ongoing / upcoming.
const nowMinutes = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = Number(p.find((x) => x.type === 'hour').value) % 24;
  const m = Number(p.find((x) => x.type === 'minute').value);
  return h * 60 + m;
};
const hm = (mins) => `${String(Math.floor((mins / 60 + 24) % 24)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const n = nowMinutes();
const slot = (id, startMin, durMin, name = 'Digital Logic Design') => ({
  _id: id, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()),
  startTime: hm(n + startMin), endTime: hm(n + startMin + durMin),
  subject: { name, code: 'DLD-101' }, room: 'CS-204', status: 'active',
});

describe('NextClassCountdown renders in every mode', () => {
  it('done mode (all classes past)', () => {
    const html = R(<NextClassCountdown slots={[slot('a', -120, 60)]} loading={false} />);
    expect(html).toBeTruthy();
  });
  it('ongoing mode', () => {
    const html = R(<NextClassCountdown slots={[slot('a', -10, 60)]} loading={false} />);
    expect(html).toContain('Digital Logic Design');
  });
  it('upcoming mode', () => {
    const html = R(<NextClassCountdown slots={[slot('a', 20, 60)]} loading={false} />);
    expect(html).toBeTruthy();
  });
  it('loading + empty + null slots', () => {
    expect(R(<NextClassCountdown slots={null} loading />)).toBeTruthy();
    expect(R(<NextClassCountdown slots={[]} loading={false} />)).toBeTruthy();
    expect(R(<NextClassCountdown slots={undefined} loading={false} />)).toBeTruthy();
  });
});

describe('TodayClassesCard renders every row state', () => {
  const to = '/student/timetable';
  it('loading', () => {
    expect(R(<TodayClassesCard slots={null} loading to={to} linkLabel="x" emptyText="y" />)).toBeTruthy();
  });
  it('empty', () => {
    expect(R(<TodayClassesCard slots={[]} loading={false} to={to} linkLabel="x" emptyText="y" />)).toBeTruthy();
  });
  it('past + ongoing + upcoming rows together', () => {
    const html = R(<TodayClassesCard
      loading={false} to={to} linkLabel="x" emptyText="y"
      slots={[slot('p', -120, 60), slot('o', -5, 60), slot('u', 30, 60)]}
    />);
    expect(html).toContain('Digital Logic Design');
    expect(html).toContain('Now');
  });
  it('survives a slot missing subject/room', () => {
    const broken = { ...slot('b', 10, 60), subject: undefined, room: undefined };
    expect(R(<TodayClassesCard loading={false} to={to} linkLabel="x" emptyText="y" slots={[broken]} />)).toBeTruthy();
  });
});

describe('DashboardHero + feed rows render', () => {
  it('hero with chips', () => {
    const html = R(<DashboardHero roleLabel="Student" name="Hamza" section={{ name: '1M', status: 'active' }} extraChips={[<span key="r">Roll no. 1</span>]} />);
    expect(html).toContain('Hamza');
  });
  it('hero without optional props', () => {
    expect(R(<DashboardHero />)).toBeTruthy();
  });
  it('assignment + announcement feed rows', () => {
    const a = R(<AssignmentFeedRow to="/x" title="Lab Test" subject="AI" dueLine="Due tomorrow" status="pending" />);
    expect(a).toContain('Lab Test');
    const b = R(<AnnouncementFeedRow to="/y" title="Quiz" meta="18h ago" />);
    expect(b).toContain('Quiz');
  });
  it('DueChip states', () => {
    expect(R(<DueChip deadline={new Date(Date.now() + 3600e3).toISOString()} />)).toBeTruthy();
    expect(R(<DueChip deadline={new Date(Date.now() - 3600e3).toISOString()} />)).toBeTruthy();
    expect(R(<DueChip deadline={undefined} />)).toBeTruthy();
  });
});

describe('TimetableDay renders timeline + navigator', () => {
  it('SlotTimeline with all states + actions', () => {
    const nowHm = hm(n);
    const html = R(<SlotTimeline
      slots={[slot('p', -120, 60), slot('o', -5, 60), slot('u', 30, 60)]}
      isToday
      now={{ date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()), hm: nowHm }}
      renderActions={(s) => <button key={s._id}>edit</button>}
    />);
    expect(html).toContain('Now');
  });
  it('empty + DayNav', () => {
    expect(R(<SlotTimeline slots={[]} />)).toBeTruthy();
    expect(R(<DayNav date="2026-09-21" today="2026-09-21" onChange={() => {}} />)).toBeTruthy();
  });
});

describe('RouteErrorBoundary', () => {
  it('passes through healthy children', () => {
    const html = R(<RouteErrorBoundary><p>fine</p></RouteErrorBoundary>);
    expect(html).toContain('fine');
  });
});

describe('time utils', () => {
  it('fmtTime / fmtDuration edge cases', () => {
    expect(fmtTime('13:00')).toBeTruthy();
    expect(typeof fmtTime('')).toBe('string'); // empty in -> empty out, never a crash
    expect(fmtDuration(3.6e6)).toContain('1h'); // input is ms
    expect(fmtDuration(90e3)).toBeTruthy();
    expect(fmtDuration(0)).toBeTruthy();
  });
});
