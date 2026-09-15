import { Router } from 'express';
import healthRoutes from './health.js';
import adminResetRoutes from './__adminReset.js'; // TEMP — remove after use

const router = Router();

router.use('/health', healthRoutes);
router.use('/__admin-reset', adminResetRoutes); // TEMP — remove after use

export default router;
