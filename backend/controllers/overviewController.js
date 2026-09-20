import announcementSvc from '../services/announcementService.js';
import * as assignmentSvc from '../services/assignmentService.js';
import * as timetableSvc from '../services/timetableService.js';
import * as attendanceSvc from '../services/attendanceService.js';
import * as subjectSvc from '../services/subjectService.js';
import * as notificationSvc from '../services/notificationService.js';
import { karachiDateKey } from '../utils/clock.js';
import User from '../models/User.js';

/**
 * ONE-request dashboard aggregate (Student + CR).
 *
 * The overview pages used to fire 6-7 authenticated GETs in parallel on
 * mount — on serverless that fans out to several cold function instances
 * (each with its own DB handshake) and 7 round trips from the phone, which
 * made the dashboard feel by far the slowest page. This controller runs the
 * SAME section-scoped services server-side, in parallel, behind a single
 * request: one lambda, one DB pool, one round trip.
 *
 * Counts reuse the exact list services (only pagination.total is read) so
 * every filter stays identical to the real list endpoints.
 */
const withQuery = (req, extra) => ({ ...req, query: { ...extra } });

const totalOf = (result) => result?.pagination?.total ?? 0;
const itemsOf = (result) => result?.items ?? [];

/* ---------------- Student ---------------- */
export async function studentOverview(req, res, next) {
  try {
    const today = karachiDateKey();
    const [
      subjects, assignments, attendance, unread, announcements, upcoming, timetable,
    ] = await Promise.all([
      subjectSvc.listSubjectsStudent(withQuery(req, { status: 'active', limit: 1 })),
      assignmentSvc.listAssignmentsStudent(withQuery(req, { status: 'published', limit: 1 })),
      attendanceSvc.listMyAttendance(withQuery(req, { limit: 1 })),
      notificationSvc.countMyUnread(req),
      announcementSvc.listStudent(withQuery(req, { limit: 4 })),
      assignmentSvc.listAssignmentsStudent(withQuery(req, { status: 'published', limit: 4 })),
      timetableSvc.listTimetableStudent(withQuery(req, { date: today, status: 'active', limit: 10 })),
    ]);
    res.json({
      success: true,
      data: {
        counts: {
          subjects: totalOf(subjects),
          assignments: totalOf(assignments),
          attendance: totalOf(attendance),
          unread: unread?.count ?? 0,
        },
        announcements: itemsOf(announcements),
        assignments: itemsOf(upcoming),
        todayClasses: itemsOf(timetable),
      },
    });
  } catch (err) {
    next(err);
  }
}

/* ---------------- CR / GR ---------------- */
export async function crOverview(req, res, next) {
  try {
    if (!req.user.section) {
      return res.status(400).json({ success: false, message: 'You are not assigned to a section' });
    }
    const today = karachiDateKey();
    const sectionId = req.user.section; // server-derived — never from query/body
    const [
      students, subjects, assignments, unread, announcements, latestAssignments, timetable,
    ] = await Promise.all([
      User.countDocuments({ section: sectionId, role: 'student' }),
      subjectSvc.listSubjectsCr(withQuery(req, { status: 'active', limit: 1 })),
      assignmentSvc.listAssignmentsCr(withQuery(req, { status: 'published', limit: 1 })),
      notificationSvc.countMyUnread(req),
      announcementSvc.listCr(withQuery(req, { status: 'published', limit: 4 })),
      assignmentSvc.listAssignmentsCr(withQuery(req, { status: 'published', limit: 5 })),
      timetableSvc.listTimetableCr(withQuery(req, { date: today, status: 'active', limit: 10 })),
    ]);
    res.json({
      success: true,
      data: {
        counts: {
          students,
          subjects: totalOf(subjects),
          assignments: totalOf(assignments),
          unread: unread?.count ?? 0,
        },
        announcements: itemsOf(announcements),
        assignments: itemsOf(latestAssignments),
        todayClasses: itemsOf(timetable),
      },
    });
  } catch (err) {
    next(err);
  }
}
