import { Router } from 'express';
import { protect, crOnly, sectionScope } from '../middleware/auth.js';
import {
  listStudents, precreateStudent,
  listSubjects, createSubject, getSubject, updateSubject, archiveSubject,
  listAnnouncements, createAnnouncement, getAnnouncement, updateAnnouncement, archiveAnnouncement,
  listNotes, createNote, getNote, updateNote, archiveNote,
  listAssignments, createAssignment, getAssignment, updateAssignment, archiveAssignment,
  listSubmissions, getSubmission,
  listTimetable, createTimetable, getTimetable, updateTimetable, archiveTimetable,
  createAttendanceSession, listAttendanceSessions, getAttendanceSession,
  cancelAttendanceSession, listAttendanceRecords,
} from '../controllers/crController.js';
import {
  listMyNotifications, getUnreadCount, markNotificationRead, markAllNotificationsRead,
} from '../controllers/notificationController.js';
import {
  createAssessment, listAssessmentsCr, getAssessmentCr, updateAssessment,
  openAssessment, finalizeAssessment, archiveAssessment,
  createMark, updateMark, bulkUpsertMarks, listMarks,
} from '../controllers/gradingController.js';
import { signFileUpload, confirmFileUpload, removeFileUpload } from '../controllers/fileController.js';

const router = Router();

// CR-only routes — section scope is ALWAYS derived from the authenticated CR
router.use(protect, crOnly, sectionScope);

// Assessments & marks — CR's OWN section only (server-derived)
router.post('/assessments', createAssessment);
router.get('/assessments', listAssessmentsCr);
router.get('/assessments/:id', getAssessmentCr);
router.patch('/assessments/:id', updateAssessment);
router.post('/assessments/:id/open', openAssessment);
router.post('/assessments/:id/finalize', finalizeAssessment);
router.post('/assessments/:id/archive', archiveAssessment);
router.post('/assessments/:assessmentId/marks', createMark);
router.patch('/assessments/:assessmentId/marks/:studentId', updateMark);
router.post('/assessments/:assessmentId/marks/bulk', bulkUpsertMarks);
router.get('/assessments/:assessmentId/marks', listMarks);

// Cloudinary direct-upload flow — signature + confirmation (no file bytes ever reach this API)
router.post('/files/sign', signFileUpload);
router.post('/files/confirm', confirmFileUpload);
router.post('/files/remove', removeFileUpload);

// In-app notifications — own mailbox only; lazy reminders generated on poll
router.get('/notifications', listMyNotifications);
router.get('/notifications/unread-count', getUnreadCount);
router.post('/notifications/:id/read', markNotificationRead);
router.post('/notifications/read-all', markAllNotificationsRead);

router.get('/students', listStudents);
router.post('/students', precreateStudent);

// Subjects — section is ALWAYS derived from the authenticated CR
router.get('/subjects', listSubjects);
router.post('/subjects', createSubject);
router.get('/subjects/:id', getSubject);
router.patch('/subjects/:id', updateSubject);
router.post('/subjects/:id/archive', archiveSubject);

// Announcements — section is ALWAYS derived from the authenticated CR
router.get('/announcements', listAnnouncements);
router.post('/announcements', createAnnouncement);
router.get('/announcements/:id', getAnnouncement);
router.patch('/announcements/:id', updateAnnouncement);
router.post('/announcements/:id/archive', archiveAnnouncement);

// Assignments — section ALWAYS req.user.section; subject must be own+active
router.get('/assignments', listAssignments);
router.post('/assignments', createAssignment);
router.get('/assignments/:id', getAssignment);
router.patch('/assignments/:id', updateAssignment);
router.post('/assignments/:id/archive', archiveAssignment);

// Submissions — read-only for CR, own section only
router.get('/assignments/:assignmentId/submissions', listSubmissions);
router.get('/submissions/:id', getSubmission);

// Timetable — section ALWAYS req.user.section; same-day overlap rejected
router.get('/timetable', listTimetable);
router.post('/timetable', createTimetable);
router.get('/timetable/:id', getTimetable);
router.patch('/timetable/:id', updateTimetable);
router.post('/timetable/:id/archive', archiveTimetable);

// Attendance sessions — section ALWAYS req.user.section; code returned once
router.post('/attendance/sessions', createAttendanceSession);
router.get('/attendance/sessions', listAttendanceSessions);
router.get('/attendance/sessions/:id', getAttendanceSession);
router.post('/attendance/sessions/:id/cancel', cancelAttendanceSession);
router.get('/attendance/sessions/:id/records', listAttendanceRecords);

// Notes — same section isolation; optional subject must belong to own section
router.get('/notes', listNotes);
router.post('/notes', createNote);
router.get('/notes/:id', getNote);
router.patch('/notes/:id', updateNote);
router.post('/notes/:id/archive', archiveNote);

export default router;
