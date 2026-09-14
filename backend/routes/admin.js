import { Router } from 'express';
import { protect, adminOnly } from '../middleware/auth.js';
import * as ctl from '../controllers/adminController.js';
import { listNotificationsAdmin } from '../controllers/notificationController.js';

const router = Router();

// Every admin route requires an authenticated, active, admin account
router.use(protect, adminOnly);

// Departments
router.post('/departments', ctl.createDepartment);
router.get('/departments', ctl.listDepartments);
router.get('/departments/:id', ctl.getDepartment);
router.patch('/departments/:id', ctl.updateDepartment);
router.post('/departments/:id/archive', ctl.archiveDepartment);

// Academic Sessions
router.post('/sessions', ctl.createSession);
router.get('/sessions', ctl.listSessions);
router.get('/sessions/:id', ctl.getSession);
router.patch('/sessions/:id', ctl.updateSession);
router.post('/sessions/:id/archive', ctl.archiveSession);

// Sections
router.post('/sections', ctl.createSection);
router.get('/sections', ctl.listSections);
router.get('/sections/:id', ctl.getSection);
router.patch('/sections/:id', ctl.updateSection);
router.post('/sections/:id/archive', ctl.archiveSection);
router.post('/sections/:id/cr', ctl.assignCr);
router.post('/sections/:id/cr/reassign', ctl.reassignCr);
router.post('/sections/:id/cr/remove', ctl.removeCr);

// CR pre-creation (creates CR + section link transactionally)
router.post('/crs', ctl.precreateCr);

// Student directory (filters: department/session/section + search + pagination)
router.get('/students', ctl.listStudentsAdmin);

// Subjects (admin may manage any active section's subjects)
router.post('/subjects', ctl.createSubjectAdmin);
router.get('/subjects', ctl.listSubjectsAdmin);
router.get('/subjects/:id', ctl.getSubjectAdmin);
router.patch('/subjects/:id', ctl.updateSubjectAdmin);
router.post('/subjects/:id/archive', ctl.archiveSubjectAdmin);

// Announcements
router.post('/announcements', ctl.createAnnouncementAdmin);
router.get('/announcements', ctl.listAnnouncementsAdmin);
router.get('/announcements/:id', ctl.getAnnouncementAdmin);
router.patch('/announcements/:id', ctl.updateAnnouncementAdmin);
router.post('/announcements/:id/archive', ctl.archiveAnnouncementAdmin);

// Assignments
router.post('/assignments', ctl.createAssignmentAdmin);
router.get('/assignments', ctl.listAssignmentsAdmin);
router.get('/assignments/:id', ctl.getAssignmentAdmin);
router.patch('/assignments/:id', ctl.updateAssignmentAdmin);
router.post('/assignments/:id/archive', ctl.archiveAssignmentAdmin);
router.get('/assignments/:assignmentId/submissions', ctl.listSubmissionsAdmin);
router.get('/submissions/:id', ctl.getSubmissionAdmin);

// Timetable
router.post('/timetable', ctl.createTimetable);
router.get('/timetable', ctl.listTimetable);
router.get('/timetable/:id', ctl.getTimetable);
router.patch('/timetable/:id', ctl.updateTimetable);
router.post('/timetable/:id/archive', ctl.archiveTimetable);

// Attendance (read-only cross-section views)
router.get('/attendance/sessions', ctl.listAttendanceSessions);
router.get('/attendance/sessions/:id', ctl.getAttendanceSession);
router.get('/attendance/sessions/:id/records', ctl.listAttendanceRecords);

// Notes
router.post('/notes', ctl.createNoteAdmin);
// In-app notifications — READ-ONLY visibility; no admin mutation route exists
router.get('/notifications', listNotificationsAdmin);

router.get('/notes', ctl.listNotesAdmin);
router.get('/notes/:id', ctl.getNoteAdmin);
router.patch('/notes/:id', ctl.updateNoteAdmin);
router.post('/notes/:id/archive', ctl.archiveNoteAdmin);

export default router;
