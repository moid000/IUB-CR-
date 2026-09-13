import { Router } from 'express';
import { health } from '../controllers/healthController.js';

const router = Router();

// Mounted at /api/health — no authentication required by design.
router.get('/', health);

export default router;
