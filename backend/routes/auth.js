import { Router } from 'express';
import { login, logout, me } from '../controllers/authController.js';
import { protect } from '../middleware/auth.js';

const router = Router();

// Public
router.post('/login', login);
router.post('/logout', logout);

// Authenticated
router.get('/me', protect, me);

export default router;
