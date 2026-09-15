import { Router } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { normalizeEmail, assertEmail } from '../utils/validators.js';
import { audit } from '../utils/audit.js';

const router = Router();

/**
 * ONE-TIME TEMP ROUTE — changes the admin account's email + password.
 * Removed immediately after use (see git history).
 * Guarded by __ADMIN_RESET_KEY; disabled unless all envs are present.
 */
router.post('/', async (req, res) => {
  const key = process.env.__ADMIN_RESET_KEY;
  const newEmailRaw = process.env.__NEW_ADMIN_EMAIL;
  const newPassword = process.env.__NEW_ADMIN_PASSWORD;
  if (!key || !newEmailRaw || !newPassword) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  const auth = req.get('x-admin-reset-key');
  if (!auth || auth !== key) {
    return res.status(401).json({ success: false, message: 'Not found' });
  }
  try {
    const email = normalizeEmail(newEmailRaw);
    try {
      assertEmail(email, 'email');
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid target email' });
    }
    const conflict = await User.findOne({ email });
    if (conflict && conflict.role !== 'admin') {
      return res.status(409).json({ success: false, message: 'Target email belongs to a non-admin account' });
    }
    const admin = conflict ?? (await User.findOne({ role: 'admin' }));
    if (!admin) return res.status(500).json({ success: false, message: 'No admin account found' });
    const oldEmail = admin.email;
    admin.email = email;
    admin.password = await bcrypt.hash(newPassword, 12);
    await admin.save();
    await audit({
      actorRole: 'system', action: 'admin.credentials_reset', entityType: 'user',
      entityId: admin._id, email, before: { email: oldEmail }, after: { email },
    });
    return res.json({ success: true, message: 'Admin credentials updated', email });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Reset failed' });
  }
});

export default router;
