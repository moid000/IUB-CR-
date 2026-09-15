import { Router } from 'express';
import User from '../models/User.js';
import { protect } from '../middleware/auth.js';
import { role } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';

const router = Router();

/**
 * ONE-TIME TEMP ROUTE — removes duplicate/legacy admin accounts.
 * Only the signed-in admin may call it; every OTHER admin is deleted.
 * Removed immediately after use (see git history).
 */
router.post('/', protect, role('admin'), async (req, res) => {
  try {
    const legacy = await User.find({ role: 'admin', _id: { $ne: req.user._id } }).select('email');
    const r = await User.deleteMany({ role: 'admin', _id: { $ne: req.user._id } });
    if (legacy.length) {
      await audit({
        actor: req.user._id, actorRole: 'admin', action: 'admin.legacy_cleanup',
        entityType: 'user', entityId: req.user._id,
        after: { deletedEmails: legacy.map((u) => u.email) },
      });
    }
    return res.json({ success: true, deleted: r.deletedCount });
  } catch {
    return res.status(500).json({ success: false, message: 'Cleanup failed' });
  }
});

export default router;
