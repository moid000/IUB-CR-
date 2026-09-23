import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { runDeadlineSweep } from '../services/deadlineSweepService.js';
import { runWatchdog } from '../services/ultramsgWatchdogService.js';
import { dispatchPendingTeacherConfirmations, handleTeacherReply } from '../services/teacherConfirmationService.js';

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
    // Reuse the owner's existing cron-job.org ping; a confirmation retry must
    // never block or change the assignment deadline sweep result.
    const teacherConfirmations = await dispatchPendingTeacherConfirmations().catch((err) => {
      console.error('[teacher confirmation sweep]', err.message);
      return { error: true };
    });
    res.json({ success: true, data: { ...report, teacherConfirmations } });
  } catch (err) {
    next(err);
  }
};

router.get('/deadline-sweep', handle);
router.post('/deadline-sweep', handle);

/**
 * Gateway watchdog — cron-job.org pings this hourly (same secret guard).
 * Checks the UltraMsg instance; renews the trial over plain HTTP if it
 * stopped for non-payment; emails the owner if a QR scan is needed.
 */
const watchdogHandle = async (req, res, next) => {
  try {
    assertSweepSecret(req);
    const report = await runWatchdog();
    res.json({ success: true, data: report });
  } catch (err) {
    next(err);
  }
};

router.get('/watchdog', watchdogHandle);
router.post('/watchdog', watchdogHandle);

/** UltraMsg inbound replies. Secret lives ONLY in Vercel and in the gateway's
 * webhook URL, separate from the existing cron secret. Invalid/unrelated
 * messages are acknowledged silently; no WhatsApp auto-reply spam. */
router.post('/teacher-reply', async (req, res, next) => {
  try {
    const expected = env.whatsapp.webhookSecret;
    if (!expected) throw new ApiError(503, 'Teacher reply webhook is not configured');
    const given = req.get('x-webhook-secret') || req.query.key;
    if (!given || !constantTimeEqual(given, expected)) throw new ApiError(401, 'Invalid webhook secret');
    const updated = await handleTeacherReply(req.body);
    res.json({ success: true, data: { updated } });
  } catch (err) { next(err); }
});

export default router;
