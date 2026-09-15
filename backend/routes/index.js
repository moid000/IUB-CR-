import { Router } from 'express';
import healthRoutes from './health.js';
import adminCleanupRoutes from './__adminCleanup.js'; // TEMP — remove after use

const router = Router();

router.use('/health', healthRoutes);
router.use('/__admin-cleanup', adminCleanupRoutes); // TEMP — remove after use

export default router;
