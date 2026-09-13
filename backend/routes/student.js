import { Router } from 'express';
import { protect, studentOnly, sectionScope } from '../middleware/auth.js';
import * as subjectSvc from '../services/subjectService.js';

const router = Router();

// Student routes are READ-ONLY — no student mutation route exists in any phase.
router.use(protect, studentOnly, sectionScope);

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
