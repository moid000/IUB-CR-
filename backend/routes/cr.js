import { Router } from 'express';
import { protect, crOnly, sectionScope } from '../middleware/auth.js';
import { listStudents, precreateStudent } from '../controllers/crController.js';

const router = Router();

// CR-only routes — section scope is ALWAYS derived from the authenticated CR
router.use(protect, crOnly, sectionScope);

router.get('/students', listStudents);
router.post('/students', precreateStudent);

export default router;
