import { Router } from 'express';
import { protect, studentOnly, sectionScope } from '../middleware/auth.js';
import * as subjectSvc from '../services/subjectService.js';
import {
  listAnnouncements, getAnnouncement, listNotes, getNote,
  listAssignments, getAssignment, submitSubmission, getMySubmission,
  listTimetable, getTimetable,
  attendWithCode, attendWithQr, listMyAttendance, listSessionsStudent,
} from '../controllers/studentController.js';
import {
  listMyNotifications, getUnreadCount, getUnreadCountByType, markNotificationRead,
  markAllNotificationsRead, markNotificationsReadByType,
} from '../controllers/notificationController.js';
import { listAssessmentsStudent, getAssessmentStudent, listMyMarks } from '../controllers/gradingController.js';
import { signFileUpload, confirmFileUpload, removeFileUpload } from '../controllers/fileController.js';
import { studentOverview } from '../controllers/overviewController.js';

const router = Router();

// Student routes are READ-ONLY — no student mutation route exists in any phase.
router.use(protect, studentOnly, sectionScope);

// ONE-request dashboard aggregate (was 7 parallel GETs — felt slow on phones)
router.get('/overview', studentOverview);

// Attendance — single verification path for manual code AND signed QR
router.get('/attendance/sessions', listSessionsStudent); // active own-section sessions (no code/hash)
router.post('/attendance/sessions/:sessionId/attend', attendWithCode);
router.post('/attendance/scan', attendWithQr);
router.get('/attendance', listMyAttendance);

// Timetable of the student's OWN section (read-only, recurring weekly slots)
router.get('/timetable', listTimetable);
router.get('/timetable/:id', getTimetable);

// Assignments of the student's OWN section + their own single submission
router.get('/assignments', listAssignments);
router.get('/assignments/:id', getAssignment);
router.post('/assignments/:assignmentId/submission', submitSubmission);
router.get('/assignments/:assignmentId/submission', getMySubmission);

// Announcements of the student's OWN section (read-only)
router.get('/announcements', listAnnouncements);
router.get('/announcements/:id', getAnnouncement);

// Notes of the student's OWN section (read-only)
router.get('/notes', listNotes);
router.get('/notes/:id', getNote);

// Assessments & marks of the student's OWN section (read-only) + own-marks history
router.get('/assessments', listAssessmentsStudent);
router.get('/assessments/:id', getAssessmentStudent);
router.get('/marks', listMyMarks);

// Cloudinary direct-upload flow — signature + confirmation (no file bytes ever reach this API)
router.post('/files/sign', signFileUpload);
router.post('/files/confirm', confirmFileUpload);
router.post('/files/remove', removeFileUpload);

// In-app notifications — own mailbox only; lazy reminders generated on poll
router.get('/notifications', listMyNotifications);
router.get('/notifications/unread-count', getUnreadCount);
router.get('/notifications/unread-count-by-type', getUnreadCountByType);
router.post('/notifications/:id/read', markNotificationRead);
router.post('/notifications/read-all', markAllNotificationsRead);
router.post('/notifications/read-by-type', markNotificationsReadByType);

// Subjects of the student's OWN section (server-derived — never a query param)
router.get('/subjects', async (req, res, next) => {
  try {
    const { items, pagination } = await subjectSvc.listSubjectsStudent(req);
    res.json({ success: true, data: items, pagination });
  } catch (err) {
    next(err);
  }
});

export default router;
