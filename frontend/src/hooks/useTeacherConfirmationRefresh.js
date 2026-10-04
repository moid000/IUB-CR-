import { useEffect, useRef } from 'react';
import { hasPendingTeacherResponse } from '../components/shared/TeacherConfirmationStatus.jsx';
import { usePkNow } from '../components/shared/TimetableDay.jsx';

/** TRUE while any class is happening RIGHT NOW (PKT today, start <= now < end,
 *  not declined). Owner bug (2026-10-04): a teacher can cancel a class AFTER it
 *  started (replies NO mid-class) — without a refresh the "class in progress"
 *  timer kept running on stale data forever. */
export const hasLiveClass = (slots, now) => (slots ?? []).some((s) =>
  s.date === now.date && s.teacherConfirmation?.status !== 'declined' && s.startTime <= now.hm && now.hm < s.endTime);

/** Poll while there are unanswered teacher requests OR a class is live right
 * now, and refresh on tab focus. Students + CR/GR poll once a minute, but
 * ONLY in those states — no constant polling at scale, no Base44 workflows,
 * no websockets. */
export default function useTeacherConfirmationRefresh(slots, refresh, intervalMs = 0) {
  const pending = hasPendingTeacherResponse(slots);
  const now = usePkNow(true); // ticks every 30s → a class going live starts the poll on its own
  const live = hasLiveClass(slots, now);
  const active = pending || live;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!active) return undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') refreshRef.current(); };
    const timer = intervalMs > 0 ? setInterval(onVisible, intervalMs) : null;
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [active, intervalMs]);
}
