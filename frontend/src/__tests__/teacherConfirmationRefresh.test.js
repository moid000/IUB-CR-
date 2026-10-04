import { describe, it, expect } from 'vitest';
import { hasLiveClass } from '../hooks/useTeacherConfirmationRefresh.js';
import { hasPendingTeacherResponse } from '../components/shared/TeacherConfirmationStatus.jsx';

/** OWNER BUG (2026-10-04): a class cancelled MID-CLASS kept its "class in
 * progress" timer running forever because the dashboard only refreshed while
 * a teacher question was pending. The hook now also polls while a class is
 * LIVE, so a mid-class NO reaches the countdown within one 60s poll. */
const NOW = { date: '2026-10-05', hm: '09:35' };
const slot = (over = {}) => ({
  _id: 'x', date: '2026-10-05', startTime: '09:00', endTime: '10:00',
  teacherConfirmation: { status: 'confirmed' }, ...over,
});

describe('hasLiveClass — poll while a class is happening right now', () => {
  it('ongoing class → live', () => {
    expect(hasLiveClass([slot()], NOW)).toBe(true);
  });

  it('not yet started → not live (no poll needed)', () => {
    expect(hasLiveClass([slot({ startTime: '11:00', endTime: '12:00' })], NOW)).toBe(false);
  });

  it('already finished → not live', () => {
    expect(hasLiveClass([slot({ startTime: '08:00', endTime: '09:00' })], NOW)).toBe(false);
  });

  it('teacher already declined → not live (no reminder, no timer)', () => {
    expect(hasLiveClass([slot({ teacherConfirmation: { status: 'declined' } })], NOW)).toBe(false);
  });

  it('other days / empty list never count', () => {
    expect(hasLiveClass([slot({ date: '2026-10-04' })], NOW)).toBe(false);
    expect(hasLiveClass([], NOW)).toBe(false);
    expect(hasLiveClass(null, NOW)).toBe(false);
  });
});

describe('poll gate: pending question OR live class', () => {
  it('mid-class cancellation scenario is covered by BOTH gates', () => {
    // question still awaiting → pending gate already polls
    expect(hasPendingTeacherResponse([slot({ teacherConfirmation: { status: 'awaiting' } })])).toBe(true);
    // teacher answered NO but the UI has not refreshed yet → slot still LOOKS
    // live → live gate keeps polling until the fresh data says declined
    expect(hasLiveClass([slot()], NOW)).toBe(true);
  });
});
