import { useEffect, useRef } from 'react';
import { hasPendingTeacherResponse } from '../components/shared/TeacherConfirmationStatus.jsx';

/** Poll ONLY while a visible timetable has unanswered teacher requests.
 * Students refresh on tab focus instead of constant polling at scale.
 * CR/GR may poll once a minute. No Base44 workflows or websockets. */
export default function useTeacherConfirmationRefresh(slots, refresh, intervalMs = 0) {
  const pending = hasPendingTeacherResponse(slots);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!pending) return undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') refreshRef.current(); };
    const timer = intervalMs > 0 ? setInterval(onVisible, intervalMs) : null;
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [pending, intervalMs]);
}
