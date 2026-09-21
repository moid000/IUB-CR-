import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { studentApi } from '../api/student.js';
import { crApi } from '../api/cr.js';
import { pktToday } from './shared/TimetableDay.jsx';

/**
 * Idle DATA prefetch — the perceived-speed layer for tab switches.
 *
 * Dashboard pehle load hota hai; ~1.2s baad, background mein wahi list
 * requests jo Assignments / Announcements / Timetable / Subjects tabs
 * khud fire karte — SAME paths + SAME params (warna cache miss hota).
 * Jab user tab kholta hai to useAdminQuery SWR snapshot se instantly
 * paint hota hai aur network sirf background revalidate karta hai.
 *
 * - Params EXACTLY page defaults se match hone chahiyen (key order bhi,
 *   kyunki qs() insertion-order string banata hai).
 * - saveData / 2g users ke liye skip (data respect).
 * - Ek portal = ek prefetch per session; fail = silent, kabhi block nahi karta.
 */

const prefetchedPortals = new Set();

const studentPrefetch = () => {
  const today = pktToday();
  return [
    studentApi.announcements.list({ page: 1, limit: 30 }),
    studentApi.assignments.list({ status: 'published', page: 1, limit: 30 }),
    studentApi.timetable.list({ date: today, status: 'active', page: 1, limit: 100 }),
    studentApi.subjects.list({ status: 'active', page: 1, limit: 50 }),
  ];
};

const crPrefetch = () => {
  const today = pktToday();
  return [
    crApi.announcements.list({ page: 1, limit: 10 }),
    crApi.assignments.list({ page: 1, limit: 10 }),
    crApi.timetable.list({ date: today, status: 'active', limit: 100 }),
    crApi.subjects.list({ status: 'active', limit: 100 }),
  ];
};

export default function DataPrefetcher() {
  const { pathname } = useLocation();
  useEffect(() => {
    const portal = pathname.startsWith('/student') ? 'student'
      : pathname.startsWith('/cr') ? 'cr' : null;
    if (!portal) return undefined;
    const conn = navigator.connection;
    if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))) return undefined;
    const id = setTimeout(() => {
      if (prefetchedPortals.has(portal)) return;
      prefetchedPortals.add(portal);
      (portal === 'student' ? studentPrefetch() : crPrefetch())
        .forEach((p) => { try { p?.catch?.(() => {}); } catch { /* non-fatal */ } });
    }, 1200);
    return () => clearTimeout(id);
  }, [pathname]);
  return null;
}
