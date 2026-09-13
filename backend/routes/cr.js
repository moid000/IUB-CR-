import { Router } from 'express';
import { protect, crOnly, sectionScope } from '../middleware/auth.js';
import {
  listStudents, precreateStudent,
  listSubjects, createSubject, getSubject, updateSubject, archiveSubject,
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

export default router;
