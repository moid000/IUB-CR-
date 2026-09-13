import { Router } from 'express';
import { protect, studentOnly, sectionScope } from '../middleware/auth.js';
import * as subjectSvc from '../services/subjectService.js';
import {
  listAnnouncements, getAnnouncement, listNotes, getNote,
  listAssignments, getAssignment, submitSubmission, getMySubmission,
} from '../controllers/studentController.js';

const router = Router();

// Student routes are READ-ONLY — no student mutation route exists in any phase.
router.use(protect, studentOnly, sectionScope);

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
