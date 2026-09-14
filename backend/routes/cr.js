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
} from '../controllers/crController.js';

const router = Router();

// CR-only routes — section scope is ALWAYS derived from the authenticated CR
router.use(protect, crOnly, sectionScope);

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

// Notes — same section isolation; optional subject must belong to own section
router.get('/notes', listNotes);
router.post('/notes', createNote);
router.get('/notes/:id', getNote);
router.patch('/notes/:id', updateNote);
router.post('/notes/:id/archive', archiveNote);

export default router;
