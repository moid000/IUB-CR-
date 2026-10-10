import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { runDeadlineSweep } from '../services/deadlineSweepService.js';
import { runWatchdog } from '../services/ultramsgWatchdogService.js';
import { dispatchPendingTeacherConfirmations, handleTeacherReply } from '../services/teacherConfirmationService.js';
// OWNER FEATURE (2026-10-04): short teacher reminder ~20 min before their class
import { runClassReminderSweep } from '../services/classReminderService.js';
// OWNER RELIABILITY SPEC (2026-10-09): every teacher attachment owns a
// persisted task — the 5-min ping also resumes crashed uploads, retries CR
// notifications (never re-uploading) and recovers pending CR questions.
import { runTeacherMaterialSweep } from '../services/teacherMaterialService.js';
import { runTeacherQuestionSweep } from '../services/teacherQuestionService.js';
// NEW (2026-10-03): Tri3M group chatbot. handleGroupMessage is a pure
// consumer of GROUP messages — it never throws, and returns false unless the
// bot is enabled AND the payload is a group text message, so the teacher
// DM flow below stays byte-for-byte identical when the bot is off.
import { handleGroupMessage } from '../services/chatbotService.js';
// OWNER RELIABILITY SPEC §9 (2026-10-10): outbox delivery tracking + retry
import { retryOutbox } from '../services/whatsappService.js';
// OWNER 2026-10-10: Wasender webhook payloads are converted into the UltraMsg
// shape BEFORE any handler runs — UltraMsg payloads pass through untouched.
import { normalizeIncomingPayload } from '../services/wasenderPayload.js';

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
    // spec ©9 heartbeat: the sweep stamps its own last-run so ops-diagnostics
    // can tell 'cron is pinging' from 'cron is dead' without Vercel logs.
    try {
      const { WatchdogState } = await import('../models/index.js');
      await WatchdogState.updateOne({ key: 'deadline-sweep:last-run' },
        { $set: { lastSentAt: new Date() } }, { upsert: true });
    } catch { /* best-effort */ }
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
    // RELIABILITY SWEEPS (owner spec 2026-10-09): crash-recovery + retries.
    const [materialReliability, questionReliability, outbox] = await Promise.allSettled([
      runTeacherMaterialSweep(), runTeacherQuestionSweep(), retryOutbox(),
    ]);
    res.json({ success: true, data: { ...report, teacherConfirmations, classReminders,
      materialReliability: materialReliability.status === 'fulfilled' ? materialReliability.value : { error: true },
      questionReliability: questionReliability.status === 'fulfilled' ? questionReliability.value : { error: true },
      outbox: outbox.status === 'fulfilled' ? outbox.value : { error: true } } });
  } catch (err) {
    next(err);
  }
};

router.get('/deadline-sweep', handle);
router.post('/deadline-sweep', handle);

/* OWNER RELIABILITY SPEC §9 (2026-10-10): ONE actionable endpoint that shows
 * the administrator the REAL live state — what is pending, what failed, what
 * the background workers last did. Read-only, same secret guard, sanitized
 * (phones masked to last 4, no message bodies). */
router.get('/ops-diagnostics', async (req, res, next) => {
  try {
    assertSweepSecret(req);
    const { WatchdogState, TeacherQuestion, TeacherMaterial, OutboxMessage, Timetable } = await import('../models/index.js');
    const mask = (p) => (p ? `…${String(p).slice(-4)}` : null);
    const [sweepBeat, dogBeat, dogRenew, dogErr] = await Promise.all([
      WatchdogState.findOne({ key: 'deadline-sweep:last-run' }).lean(),
      WatchdogState.findOne({ key: 'watchdog:last-run' }).lean(),
      WatchdogState.findOne({ key: 'watchdog:last-renewal' }).lean(),
      WatchdogState.findOne({ key: 'watchdog:last-extend-error' }).lean(),
    ]);
    const now = Date.now();
    const questions = await TeacherQuestion.find({ status: { $in: ['pending_cr', 'cr_responded'] } })
      .sort({ askedAt: 1 }).limit(50).lean();
    const materials = await TeacherMaterial.find({ status: { $in: ['received', 'uploading', 'awaiting_subject', 'offered'] } })
      .sort({ updatedAt: 1 }).limit(50).lean();
    const outboxFailed = await OutboxMessage.find({ status: 'failed' }).sort({ updatedAt: -1 }).limit(30).lean();
    const crNotifyPending = await TeacherMaterial.find({ 'crNotify.sent': false }).sort({ updatedAt: -1 }).limit(20).lean();
    const awaitingClasses = await Timetable.countDocuments({ status: 'active', 'teacherConfirmation.status': 'awaiting' });
    res.json({ success: true, data: {
      heartbeat: {
        deadlineSweepLastRun: sweepBeat?.lastSentAt ?? null,
        watchdogLastRun: dogBeat?.lastSentAt ?? null,
        watchdogLastRenewal: dogRenew?.lastSentAt ?? null,
        watchdogLastExtendError: dogErr?.value ?? null,
      },
      questions: questions.map((q) => ({ ref: q.refCode, phone: mask(q.phone), status: q.status,
        ageHours: Math.round((now - new Date(q.askedAt).getTime()) / 3600000), nudges: q.crReminders,
        escalatedTo: q.escalatedToName || null, dispatchAttempts: q.crNotifyAttempts })),
      answersAwaitingDelivery: questions.filter((q) => q.status === 'cr_responded').length,
      materials: materials.map((m) => ({ id: String(m._id).slice(-8), filename: (m.filename ?? '').slice(0, 60),
        status: m.status, ageHours: Math.round((now - new Date(m.updatedAt).getTime()) / 3600000) })),
      crNotifyPending: crNotifyPending.map((m) => ({ id: String(m._id).slice(-8), attempts: m.crNotify?.attempts ?? 0 })),
      outboxFailed: outboxFailed.map((o) => ({ kind: o.kind, refKey: o.refKey, phone: mask(o.phone),
        attempts: o.attempts, lastError: (o.lastError ?? '').slice(0, 120), ageMinutes: Math.round((now - new Date(o.updatedAt).getTime()) / 60000) })),
      classesAwaitingTeacher: awaitingClasses,
    } });
  } catch (err) { next(err); }
});

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
    // Wasender sends its secret as X-Webhook-Signature; UltraMsg uses
    // x-webhook-secret / ?key — both are accepted, one shared secret.
    const given = req.get('x-webhook-secret') || req.get('x-webhook-signature') || req.query.key;
    if (!given || !constantTimeEqual(given, expected)) throw new ApiError(401, 'Invalid webhook secret');
    // Wasender payloads are normalized into the UltraMsg shape here —
    // every downstream handler sees the exact payload it has always seen.
    const payload = await normalizeIncomingPayload(req.body);
    // Group messages go to the chatbot FIRST; when it is disabled or the
    // message is not a group message this is a no-op and the teacher flow
    // runs exactly as before.
    const botHandled = await handleGroupMessage(payload);
    const updated = botHandled ? false : await handleTeacherReply(payload);
    res.json({ success: true, data: { updated } });
  } catch (err) { next(err); }
});


export default router;
