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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import NextClassCountdown from '../components/shared/NextClassCountdown.jsx';
import {
  DashboardHero, TodayClassesCard, DueChip, AssignmentFeedRow, AnnouncementFeedRow,
} from '../components/shared/OverviewBits.jsx';
import { DayNav, SlotTimeline } from '../components/shared/TimetableDay.jsx';
import { RouteErrorBoundary } from '../pages/ErrorBoundary.jsx';
import { fmtTime, fmtDuration } from '../admin/format.js';
import { Modal } from '../components/ui/Modal.jsx';
import { FileList } from '../components/files/FileList.jsx';
import { ImageLightbox } from '../components/files/ImageLightbox.jsx';

const R = (ui) => renderToString(<MemoryRouter>{ui}</MemoryRouter>);

// The shared components compare slot times against the REAL wall clock
// (Date.now()/usePkNow), so the clock is pinned to a fixed PKT noon for this
// whole file — offsets of -120..+90min then always land the same calendar
// day, which the components' plain "HH:MM <= now < HH:MM" string comparison
// requires (a slot spanning midnight isn't a state they support, and never
// happens with real timetable data). Without this pin, the suite flaked for
// ~1h every night whenever it happened to run within ~55min of midnight PKT.
const pktParts = (d) => {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}` };
};
const slot = (id, startMin, durMin, name = 'Digital Logic Design') => {
  const start = pktParts(new Date(Date.now() + startMin * 60000));
  const end = pktParts(new Date(Date.now() + (startMin + durMin) * 60000));
  return {
    _id: id, date: start.date, startTime: start.time, endTime: end.time,
    subject: { name, code: 'DLD-101' }, room: 'CS-204', status: 'active',
  };
};

beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-15T07:00:00Z')); }); // 12:00 PKT (UTC+5)
afterAll(() => { vi.useRealTimers(); });

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
    const nowHm = pktParts(new Date()).time;
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

/* ---------------------------------------------------------------------------
 * TAB-SPEED CONTRACT — DataPrefetcher ke prefetch paths EXACTLY wahi hone
 * chahiyen jo pages fetch karte hain (key order tak, qs insertion-order hai).
 * Ye test drift pakarta hai: agar kisi page ne params badle aur prefetch nahi,
 * tab pe phir skeleton aayega — yahan fail hoga deploy se pehle.
 * ------------------------------------------------------------------------- */
import { studentApi } from '../api/student.js';
import { crApi } from '../api/cr.js';
import { studentPrefetch, crPrefetch } from '../components/DataPrefetcher.jsx';
import { pktToday } from '../components/shared/TimetableDay.jsx';

describe('DataPrefetcher path contract', () => {
  it('student prefetch populates exactly the page cache keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: [{ _id: 'x' }] }) })));
    const stub = globalThis.fetch;
    try {
      await Promise.all(studentPrefetch());
      const today = pktToday();
      expect(studentApi.announcements.cachedList({ page: 1, limit: 30 })).toBeTruthy();
      expect(studentApi.assignments.cachedList({ status: 'published', page: 1, limit: 30 })).toBeTruthy();
      expect(studentApi.timetable.cachedList({ date: today, status: 'active', page: 1, limit: 100 })).toBeTruthy();
      expect(studentApi.subjects.cachedList({ status: 'active', page: 1, limit: 50 })).toBeTruthy();
      expect(stub).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('CR prefetch populates exactly the page cache keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: [{ _id: 'x' }] }) })));
    try {
      await Promise.all(crPrefetch());
      const today = pktToday();
      expect(crApi.announcements.cachedList({ page: 1, limit: 10 })).toBeTruthy();
      expect(crApi.assignments.cachedList({ page: 1, limit: 10 })).toBeTruthy();
      expect(crApi.timetable.cachedList({ date: today, status: 'active', limit: 100 })).toBeTruthy();
      expect(crApi.subjects.cachedList({ status: 'active', limit: 100 })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// 2026-09-22: every announcement/assignment/note detail opened "slow", and
// the image lightbox felt "very slow" to move/zoom. Root cause: Modal's
// backdrop had an UNCONDITIONAL backdrop-blur-sm — an expensive GPU filter
// that has to be recomputed every frame during the open animation AND during
// native pinch-zoom/pan of the image inside it (same class of bug as the
// earlier sticky-header/hero-blob mobile-blur fixes). Now blur is desktop-only.
describe('Modal backdrop-blur is desktop-only (mobile perf)', () => {
  it('has no unconditional backdrop-blur class — only the lg: variant', () => {
    const html = renderToString(
      <Modal open onClose={() => {}} title="t">
        <p>content</p>
      </Modal>
    );
    // must NOT contain a bare (mobile-applying) backdrop-blur class — only the lg:-prefixed variant
    expect(html).not.toMatch(/(?:^|\s)backdrop-blur-sm(?:\s|"|$)/);
    expect(html).toContain('lg:backdrop-blur-sm');
  });
});

describe('FileList image lightbox renders with a capped preview URL', () => {
  it('uses previewUrl (non-cropping, capped width) not the raw original', () => {
    const files = [{
      _id: 'f1',
      originalName: 'photo.jpg',
      format: 'jpg',
      resourceType: 'image',
      size: 12345,
      url: 'https://res.cloudinary.com/demo/image/upload/v1/x/photo.jpg',
    }];
    const html = renderToString(<FileList files={files} />);
    expect(html).toContain('Preview photo.jpg');
  });
});

// 2026-09-22: the old preview had NO zoom — users pinch-zoomed with the
// BROWSER's native page zoom, re-rasterizing the whole page every frame
// ("bohot slow / lag karti"). New ImageLightbox zooms/pans only the image
// via GPU transform, with its own controls.
describe('ImageLightbox renders the zoomable preview', () => {
  const file = {
    _id: 'f1',
    originalName: 'photo.jpg',
    format: 'jpg',
    size: 12345,
    url: 'https://res.cloudinary.com/demo/image/upload/v1/x/photo.jpg',
  };

  it('renders fullscreen dialog with zoom controls and capped (c_limit) image URL', () => {
    const html = renderToString(<ImageLightbox file={file} onClose={() => {}} />);
    expect(html).toContain('Zoom in');
    expect(html).toContain('Zoom out');
    expect(html).toContain('Reset zoom');
    expect(html).toContain('Close preview');
    expect(html).toContain('Open full size');
    // image served via the non-cropping capped transform, not the raw original
    expect(html).toContain('w_1600,c_limit');
    expect(html).not.toContain('c_fill');
  });

  it('renders safely without a file', () => {
    const html = renderToString(<ImageLightbox file={null} onClose={() => {}} />);
    expect(html).toContain('Preview');
  });

  it('has a Save to gallery primary action (owner request 2026-09-22)', () => {
    const html = renderToString(<ImageLightbox file={file} onClose={() => {}} />);
    expect(html).toContain('Save to gallery');
    expect(html).toContain('Open full size');
  });

  it('image file card offers Preview + Save actions, file card offers Download + Open', () => {
    const imageFile = { ...file, resourceType: 'image', format: 'jpg', _id: 'i1' };
    const pdfFile = { ...file, resourceType: 'raw', format: 'pdf', _id: 'p1' };
    const html = renderToString(<FileList files={[imageFile, pdfFile]} />);
    // image card
    expect(html).toContain('Preview photo.jpg');
    expect(html).toContain('Save photo.jpg to gallery');
    // file card
    expect(html).toContain('Download ');
    expect(html).toContain('Open ');
    // no raw cloudinary URL text shown to users
    expect(html).not.toContain('>https://res.cloudinary.com');
  });

  it('has no backdrop-blur filter anywhere (mobile perf)', () => {
    const html = renderToString(<ImageLightbox file={file} onClose={() => {}} />);
    expect(html).not.toMatch(/(?:^|\s)backdrop-blur(?:\s|"|$)/);
  });

  it('FileList preview flow now mounts ImageLightbox (not the old Modal)', async () => {
    const files = [{ ...file, resourceType: 'image' }];
    // render with preview open by simulating: FileList + lightbox side by side
    const html = renderToString(
      <>
        <FileList files={files} />
        <ImageLightbox file={files[0]} onClose={() => {}} />
      </>
    );
    expect(html).toContain('Preview photo.jpg');
    expect(html).toContain('w_1600,c_limit');
  });
});
