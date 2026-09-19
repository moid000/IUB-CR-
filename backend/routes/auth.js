import { Router } from 'express';
import { login, logout, me, changePassword } from '../controllers/authController.js';
import { signAvatarUpload, confirmAvatarUpload, removeAvatar } from '../controllers/fileController.js';
import * as activation from '../controllers/activationController.js';
// (GR activation routes are registered alongside CR activation below)
import { protect } from '../middleware/auth.js';

const router = Router();

// Core auth
router.post('/login', login);
router.post('/logout', logout);
router.get('/me', protect, me);

// STEP 18 — self-service credential & avatar management (any authenticated role)
router.post('/change-password', protect, changePassword);
router.post('/avatar/sign', protect, signAvatarUpload);
router.post('/avatar/confirm', protect, confirmAvatarUpload);
router.post('/avatar/remove', protect, removeAvatar);

// CR activation (public — lookup returns the pending profile by owner's design)
router.post('/cr/lookup', activation.crLookup);
router.post('/cr/request-otp', activation.crRequestOtp);
router.post('/cr/verify-otp', activation.crVerifyOtp);
router.post('/cr/set-password', activation.crSetPassword);

// GR activation (public — lookup returns the pending profile by owner's design)
router.post('/gr/lookup', activation.grLookup);
router.post('/gr/request-otp', activation.grRequestOtp);
router.post('/gr/verify-otp', activation.grVerifyOtp);
router.post('/gr/set-password', activation.grSetPassword);

// Student activation (public — lookup returns the pending profile by owner's design)
router.post('/student/lookup', activation.studentLookup);
router.post('/student/request-otp', activation.studentRequestOtp);
router.post('/student/verify-otp', activation.studentVerifyOtp);
router.post('/student/set-password', activation.studentSetPassword);

// Password reset for active accounts (public — email enumeration safe)
router.post('/forgot-password/request-otp', activation.resetRequestOtp);
router.post('/forgot-password/verify-otp', activation.resetVerifyOtp);
router.post('/forgot-password/set-password', activation.resetSetPassword);


/* ---- Web Push (device notifications) — owner-scoped subscription mgmt ---- */
import { getVapidPublicKey, subscribePush, unsubscribePush } from '../services/pushService.js';

router.get('/push/key', protect, (req, res, next) => {
  try { res.json({ success: true, data: getVapidPublicKey() }); } catch (err) { next(err); }
});
router.post('/push/subscribe', protect, async (req, res, next) => {
  try { res.json({ success: true, data: await subscribePush(req) }); } catch (err) { next(err); }
});
router.post('/push/unsubscribe', protect, async (req, res, next) => {
  try { res.json({ success: true, data: await unsubscribePush(req) }); } catch (err) { next(err); }
});

export default router;
