import { Router } from 'express';
import { protect, adminOnly } from '../middleware/auth.js';
import * as ctl from '../controllers/adminController.js';

const router = Router();

// Every admin route requires an authenticated, active, admin account
router.use(protect, adminOnly);

// Departments
router.post('/departments', ctl.createDepartment);
router.get('/departments', ctl.listDepartments);
router.patch('/departments/:id', ctl.updateDepartment);
router.post('/departments/:id/archive', ctl.archiveDepartment);

// Academic Sessions
router.post('/sessions', ctl.createSession);
router.get('/sessions', ctl.listSessions);
router.patch('/sessions/:id', ctl.updateSession);
router.post('/sessions/:id/archive', ctl.archiveSession);

// Sections
router.post('/sections', ctl.createSection);
router.get('/sections', ctl.listSections);
router.get('/sections/:id', ctl.getSection);
router.patch('/sections/:id', ctl.updateSection);
router.post('/sections/:id/archive', ctl.archiveSection);
router.post('/sections/:id/cr', ctl.assignCr);

// CR pre-creation (creates CR + section link transactionally)
router.post('/crs', ctl.precreateCr);

export default router;
