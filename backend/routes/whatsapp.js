import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { runDeadlineSweep } from '../services/deadlineSweepService.js';
import { runWatchdog } from '../services/ultramsgWatchdogService.js';
import { dispatchPendingTeacherConfirmations, handleTeacherReply } from '../services/teacherConfirmationService.js';
// OWNER FEATURE (2026-10-04): short teacher reminder ~20 min before their class
import { runClassReminderSweep } from '../services/classReminderService.js';
// NEW (2026-10-03): Tri3M group chatbot. handleGroupMessage is a pure
// consumer of GROUP messages — it never throws, and returns false unless the
// bot is enabled AND the payload is a group text message, so the teacher
// DM flow below stays byte-for-byte identical when the bot is off.
import { handleGroupMessage } from '../services/chatbotService.js';

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
    // 20-min pre-class teacher reminder — same ping, must never break the sweep
    const classReminders = await runClassReminderSweep().catch((err) => {
      console.error('[class reminder sweep]', err.message);
      return { error: true };
    });
    res.json({ success: true, data: { ...report, teacherConfirmations, classReminders } });
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
/* VOICE NOTE DIAGNOSTICS (owner incident 2026-10-08): the same secret guard
 * as the sweep — returns the latest voice-note pipeline records so a voice
 * incident can be pinpointed without runtime logs. Read-only. */
router.get('/voice-log', async (req, res, next) => {
  try {
    assertSweepSecret(req);

    const { VoiceDiag } = await import('../models/index.js');
    const rows = await VoiceDiag.find({}).sort({ createdAt: -1 }).limit(30).lean();
    res.json({ success: true, data: rows.map(({ _id, __v, ...r }) => r) });
  } catch (err) { next(err); }
});

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
    // Group messages go to the chatbot FIRST; when it is disabled or the
    // message is not a group message this is a no-op and the teacher flow
    // runs exactly as before.
    const botHandled = await handleGroupMessage(req.body);
    const updated = botHandled ? false : await handleTeacherReply(req.body);
    res.json({ success: true, data: { updated } });
  } catch (err) { next(err); }
});


/* TEMPORARY READ-ONLY DIAGNOSTIC (owner file-silence incident 2026-10-09 ~00:20 PKT).
 * Same secret as teacher-reply. NO sends, NO writes — pure DB reads mirroring
 * handleTeacherFile's exact gate sequence. REMOVE after the incident is closed. */
router.post('/diag', async (req, res, next) => {
  try {
    const expected = env.whatsapp.webhookSecret;
    if (!expected) throw new ApiError(503, 'not configured');
    const given = req.get('x-webhook-secret') || req.query.key;
    if (!given || !constantTimeEqual(given, expected)) throw new ApiError(401, 'Invalid webhook secret');
    const { Teacher, TeacherMaterial } = await import('../models/index.js');
    const phone = String(req.body?.phone ?? '923078896956').replace(/\D/g, '');
    const out = { phone, gates: {}, env: {
      instanceId: env.whatsapp.instanceId,
      hasGoogleKey: Boolean(env.gemini?.apiKey ?? process.env.GOOGLE_API_KEY),
      dbUriHost: String(process.env.MONGODB_URI ?? '').split('@')[1]?.split(/[/?]/)[0] ?? null,
      dbName: (process.env.MONGODB_URI ?? '').split('?')[0].split('/').pop() || '(default-test)',
    } };
    out.gates.teacherLookup = (await Teacher.find({ whatsapp: phone })
      .populate('subject', 'name code').populate({ path: 'section', select: 'name' }).lean())
      .map((t) => ({ id: String(t._id), name: t.name, subject: t.subject?.name ?? null,
        section: t.section?.name ?? null, active: t.active }));
    out.gates.teacherCount = out.gates.teacherLookup.length;
    out.gates.idempotencyProbe = await TeacherMaterial.findOne({ waMsgId: `diag-${Date.now()}` }).lean() ? 'unexpected-hit' : 'clean';
    const recent = await TeacherMaterial.find({ $or: [{ teacherPhone: phone }, { phone }] })
      .sort({ createdAt: -1 }).limit(6).lean();
    out.recentMaterials = recent.map((m) => ({ status: m.status, ext: m.ext, filename: m.filename,
      waMsgId: String(m.waMsgId ?? '').slice(0, 30), createdAt: m.createdAt, error: m.error ?? null }));
    out.materialCount = await TeacherMaterial.countDocuments({});
    res.json({ success: true, data: out });
  } catch (err) { next(err); }
});

export default router;
