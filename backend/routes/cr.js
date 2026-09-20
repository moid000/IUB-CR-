import { Router } from 'express';
import { protect, crOnly, sectionScope } from '../middleware/auth.js';
import {
  listStudents, precreateStudent,
  listSubjects, createSubject, getSubject, updateSubject, archiveSubject, deleteSubject,
  listAnnouncements, createAnnouncement, getAnnouncement, updateAnnouncement, archiveAnnouncement, deleteAnnouncement,
  listNotes, createNote, getNote, updateNote, archiveNote, deleteNote,
  listAssignments, createAssignment, getAssignment, updateAssignment, archiveAssignment, deleteAssignment,
  listSubmissions, getSubmission,
  listTimetable, createTimetable, copyTimetable, getTimetable, updateTimetable, archiveTimetable, deleteTimetable,
  createAttendanceSession, listAttendanceSessions, getAttendanceSession,
  cancelAttendanceSession, listAttendanceRecords,
} from '../controllers/crController.js';
import {
  listMyNotifications, getUnreadCount, getUnreadCountByType, markNotificationRead,
  markAllNotificationsRead, markNotificationsReadByType,
} from '../controllers/notificationController.js';
import {
  createAssessment, listAssessmentsCr, getAssessmentCr, updateAssessment,
  openAssessment, finalizeAssessment, archiveAssessment, deleteAssessment,
  createMark, updateMark, bulkUpsertMarks, listMarks,
} from '../controllers/gradingController.js';
import { signFileUpload, confirmFileUpload, removeFileUpload } from '../controllers/fileController.js';
import { listTeachers, createTeacher, updateTeacher, deleteTeacher } from '../controllers/teacherController.js';

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
router.delete('/assessments/:id', deleteAssessment);
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
router.get('/notifications/unread-count-by-type', getUnreadCountByType);
router.post('/notifications/:id/read', markNotificationRead);
router.post('/notifications/read-all', markAllNotificationsRead);
router.post('/notifications/read-by-type', markNotificationsReadByType);

router.get('/students', listStudents);
router.post('/students', precreateStudent);

// Subjects — section is ALWAYS derived from the authenticated CR
router.get('/subjects', listSubjects);
router.post('/subjects', createSubject);
router.get('/subjects/:id', getSubject);
router.patch('/subjects/:id', updateSubject);
router.post('/subjects/:id/archive', archiveSubject);
router.delete('/subjects/:id', deleteSubject);

// Teachers — one teacher per subject; section ALWAYS req.user.section
router.get('/teachers', listTeachers);
router.post('/teachers', createTeacher);
router.patch('/teachers/:id', updateTeacher);
router.delete('/teachers/:id', deleteTeacher);

// Announcements — section is ALWAYS derived from the authenticated CR
router.get('/announcements', listAnnouncements);
router.post('/announcements', createAnnouncement);
router.get('/announcements/:id', getAnnouncement);
router.patch('/announcements/:id', updateAnnouncement);
router.post('/announcements/:id/archive', archiveAnnouncement);
router.delete('/announcements/:id', deleteAnnouncement);

// Assignments — section ALWAYS req.user.section; subject must be own+active
router.get('/assignments', listAssignments);
router.post('/assignments', createAssignment);
router.get('/assignments/:id', getAssignment);
router.patch('/assignments/:id', updateAssignment);
router.post('/assignments/:id/archive', archiveAssignment);
router.delete('/assignments/:id', deleteAssignment);

// Submissions — read-only for CR, own section only
router.get('/assignments/:assignmentId/submissions', listSubmissions);
router.get('/submissions/:id', getSubmission);

// Timetable — section ALWAYS req.user.section; same-day overlap rejected
router.get('/timetable', listTimetable);
router.post('/timetable', createTimetable);
router.post('/timetable/copy', copyTimetable);
router.get('/timetable/:id', getTimetable);
router.patch('/timetable/:id', updateTimetable);
router.post('/timetable/:id/archive', archiveTimetable);
router.delete('/timetable/:id', deleteTimetable);

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
router.delete('/notes/:id', deleteNote);

export default router;
