import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { runDeadlineSweep } from '../services/deadlineSweepService.js';

/**
 * External pinger endpoints (cron-job.org hits this every ~5 minutes).
 *
 * Secret-protected via DEADLINE_SWEEP_SECRET — checked from the
 * `x-sweep-secret` header, `Authorization: Bearer <secret>`, or `?secret=`.
 * GET is supported because cron-job.org free jobs use GET.
 */
const router = Router();

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function assertSweepSecret(req) {
  const expected = env.whatsapp.sweepSecret;
  if (!expected) throw new ApiError(503, 'Deadline sweep is not configured on the server');
  const provided =
    req.get('x-sweep-secret') ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) ||
    req.query.secret ||
    null;
  if (!provided || !constantTimeEqual(provided, expected)) {
    throw new ApiError(401, 'Invalid sweep secret');
  }
}

const handle = async (req, res, next) => {
  try {
    assertSweepSecret(req);
    const report = await runDeadlineSweep();
    res.json({ success: true, data: report });
  } catch (err) {
    next(err);
  }
};

router.get('/deadline-sweep', handle);
router.post('/deadline-sweep', handle);

export default router;
