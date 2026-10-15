import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { runDeadlineSweep } from '../services/deadlineSweepService.js';
import { runWatchdog } from '../services/ultramsgWatchdogService.js';
import { dispatchPendingTeacherConfirmations, handleTeacherReply } from '../services/teacherConfirmationService.js';
// OWNER FEATURE (2026-10-04): short teacher reminder ~20 min before their class
import { runClassReminderSweep } from '../services/classReminderService.js';
// OWNER SPEC (2026-10-14): self-hosted crash-beacon watch — same ping, zero
// new infrastructure. Emails the owner when the frontend beacon records a
// new client error; must never block the deadline sweep.
import { runBeaconWatch } from '../services/beaconWatchService.js';
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
import * as whatsappService from '../services/whatsappService.js';
// OWNER 2026-10-10: Wasender webhook payloads are converted into the UltraMsg
// shape BEFORE any handler runs — UltraMsg payloads pass through untouched.
import { normalizeIncomingPayload, MEDIA_WRAPPERS } from '../services/wasenderPayload.js';

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
    // Crash-beacon watch rides the same ping (owner spec 2026-10-14).
    const beaconWatch = await runBeaconWatch().catch((err) => {
      console.error('[beacon watch]', err.message);
      return { error: true };
    });
    // RELIABILITY SWEEPS (owner spec 2026-10-09): crash-recovery + retries.
    const [materialReliability, questionReliability, outbox] = await Promise.allSettled([
      runTeacherMaterialSweep(), runTeacherQuestionSweep(), retryOutbox(),
    ]);
    res.json({ success: true, data: { ...report, teacherConfirmations, classReminders, beaconWatch,
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
/** OPS CHATBOT SWITCH (2026-10-11 owner lockout): the admin-panel
 * Administration page is the normal path; when the panel itself is
 * unreachable this secret-guarded toggle (same guard as the sweeps)
 * flips the DB master switch so the group bot is never stuck OFF. */
router.post('/ops-chatbot', async (req, res, next) => {
  try {
    assertSweepSecret(req);
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') throw new ApiError(400, '"enabled" must be true or false');
    const { ChatbotSetting } = await import('../models/index.js');
    const doc = await ChatbotSetting.findOneAndUpdate(
      { key: 'global' }, { $set: { key: 'global', enabled } },
      { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
    console.log(`[ops] chatbot master switch set to ${enabled} via ops-chatbot (secret-guarded)`);
    res.json({ success: true, data: { enabled: doc.enabled === true, updatedAt: doc.updatedAt } });
  } catch (err) { next(err); }
});

/* OWNER E2E VERIFICATION (2026-10-11, repair mandate item D): secret-guarded
 * live-injection endpoint. It builds a NORMALIZED inbound payload and runs the
 * REAL handlers — the full production pipeline (tag gate, Gemini, gateway
 * sends) executes exactly as for a genuine webhook, minus only the webhook
 * signature (the sweep secret guards this instead). For group mode the bot's
 * own LID (resolved live) rides in mentionedJid so the tag gate passes the
 * same way a real picker-@ mention does. */
router.post('/ops-replay', async (req, res, next) => {
  try {
    assertSweepSecret(req);
    const mode = String(req.body?.mode ?? '');
    const body = String(req.body?.body ?? '').slice(0, 400);
    const digits = (v) => String(v ?? '').replace(/\D/g, '');
    // wasender-raw carries its own full provider payload — no 'body' field
    if (!body && mode !== 'teacher-file' && mode !== 'wasender-raw') throw new ApiError(400, '"body" required');
    if (mode === 'group') {
      const { Section } = await import('../models/index.js');
      const sec = await Section.findOne({ 'whatsappGroup.id': { $ne: null } }).lean();
      if (!sec?.whatsappGroup?.id) throw new ApiError(503, 'no linked group');
      let selfLid = null;
      try { selfLid = await whatsappService.getLidFromPhone(env.whatsapp?.gatewayPhone ?? ''); } catch { /* optional */ }
      const payload = { event_type: 'message_received',
        data: { id: `opsreplay_${Date.now()}`, from: sec.whatsappGroup.id, author: `${digits(req.body?.authorDigits)}@c.us`,
          type: 'chat', body, time: Math.floor(Date.now() / 1000), fromMe: false,
          mentionedJid: selfLid ? [selfLid] : [] } };
      // create the audit row FIRST (the real webhook does this) so every
      // traceGroup() exit reason PERSISTS and ops shows exactly where the
      // pipeline stopped — without this, synthetic traces vanish.
      const { WhatsAppEvent, ChatbotLog } = await import('../models/index.js');
      await WhatsAppEvent.create({ msgId: payload.data.id, from: sec.whatsappGroup.id,
        author: payload.data.author, chatType: 'group', msgType: 'chat' }).catch(() => {});
      const handled = await handleGroupMessage(payload);
      // evidence read-back: the trace this run left + the newest bot answer
      const ev = await WhatsAppEvent.findOne({ msgId: payload.data.id }).lean();
      const lastLog = await ChatbotLog.findOne({}).sort({ createdAt: -1 }).lean();
      res.json({ success: true, data: { handled,
        groupId: sec.whatsappGroup.id.slice(-12),
        selfLidTail: String(selfLid ?? '').replace(/\D/g, '').slice(-8) || null,
        botHandled: ev?.botHandled === true,
        trace: ev?.groupTrace ?? null,
        lastAnswerAt: lastLog?.createdAt ?? null,
        lastAnswerQ: (lastLog?.question ?? '').slice(0, 120),
        lastAnswerSource: lastLog?.source ?? null,
        // OWNER SPEC 2026-10-13 live E2E: the shipped reply text (masked-free
        // group answer, no personal data) — evidence of the CR mention etc.
        lastAnswerText: (lastLog?.reply ?? '').slice(0, 400) } });
    } else if (mode === 'teacher') {
      const from = digits(req.body?.fromDigits);
      if (!from) throw new ApiError(400, '"fromDigits" required');
      const payload = { event_type: 'message_received',
        instanceId: env.whatsapp?.instanceId ?? null,
        data: { id: `opsreplay_${Date.now()}`, from: `${from}@c.us`, type: 'chat', body,
          time: Math.floor(Date.now() / 1000), fromMe: false } };
      const handled = await handleTeacherReply(payload);
      res.json({ success: true, data: { handled } });
    } else if (mode === 'teacher-file') {
      // LIVE E2E (owner spec 2026-10-11 §5): replay a real teacher FILE through
      // the full pipeline — classification, approval/caption logic, Cloudinary
      // upload, CR notifications. Requires a real public media URL.
      const from = digits(req.body?.fromDigits);
      const mediaUrl = String(req.body?.mediaUrl ?? '');
      const filename = String(req.body?.filename ?? '').slice(0, 200);
      if (!from) throw new ApiError(400, '"fromDigits" required');
      if (!/^https?:\/\//.test(mediaUrl)) throw new ApiError(400, '"mediaUrl" must be a public http(s) URL');
      if (!filename) throw new ApiError(400, '"filename" required');
      const payload = { event_type: 'message_received',
        instanceId: env.whatsapp?.instanceId ?? null,
        data: { id: `opsreplay_${Date.now()}`, from: `${from}@c.us`, type: 'document',
          filename, mimetype: req.body?.mimetype ?? 'application/pdf',
          caption: String(req.body?.caption ?? '').slice(0, 600), media: mediaUrl,
          time: Math.floor(Date.now() / 1000), fromMe: false } };
      const handled = await handleTeacherReply(payload);
      const { TeacherMaterial } = await import('../models/index.js');
      const mat = await TeacherMaterial.findOne({ waMsgId: payload.data.id }).lean();
      res.json({ success: true, data: { handled,
        materialId: mat ? String(mat._id).slice(-8) : null,
        materialStatus: mat?.status ?? null,
        publishedNote: mat?.publishedNote ? String(mat.publishedNote).slice(-8) : null,
        crNotify: mat?.crNotify ?? null } });
    } else if (mode === 'wasender-raw') {
      // OWNER SPEC 2026-10-12: replay an EXACT Wasender webhook payload
      // (event messages.received, raw Baileys message incl. WRAPPED media)
      // through normalizeIncomingPayload + the real pipeline — the same
      // shape the provider delivers, so wrapper handling is verifiable
      // without waiting for a teacher to resend a real file.
      const raw = req.body?.payload;
      if (!raw?.data?.messages?.key?.id || !raw?.data?.messages?.message) {
        throw new ApiError(400, '"payload" must be a full messages.received body (data.messages.key.id + data.messages.message)');
      }
      raw.data.messages.key.id = `${raw.data.messages.key.id.slice(0, 180)}_ops${Date.now() % 100000}`;
      const payload = await normalizeIncomingPayload(raw);
      const handled = await handleTeacherReply(payload);
      const { TeacherMaterial } = await import('../models/index.js');
      const mat = await TeacherMaterial.findOne({ waMsgId: raw.data.messages.key.id }).lean();
      res.json({ success: true, data: { handled,
        normalizedType: payload?.data?.type ?? null,
        normalizedHasUrl: Boolean(payload?.data?.mediaUrl),
        normalizedCaption: String(payload?.data?.caption ?? '').slice(0, 120) || null,
        materialId: mat ? String(mat._id).slice(-8) : null,
        materialStatus: mat?.status ?? null,
        publishedNote: mat?.publishedNote ? String(mat.publishedNote).slice(-8) : null } });
    } else throw new ApiError(400, '"mode" must be group, teacher, teacher-file or wasender-raw');
  } catch (err) { next(err); }
});

router.get('/ops-diagnostics', async (req, res, next) => {
  try {
    assertSweepSecret(req);
    const { WatchdogState, TeacherQuestion, TeacherMaterial, OutboxMessage, Timetable, WhatsAppEvent, Section, ChatbotSetting, ChatbotLog, NoteDeliveryJob, ClientError } = await import('../models/index.js');
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
    // WASENDER 2026-10-11 (owner spec item 9): webhook + outbound health
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const [lastEvent, inbound24h, redeliveries24h, lastSentRow, recentEvents, linkedGroups, chatbotDoc, byType24h, lastDirect, recentDirect, botRecent, recentDeliveryJobs, botTraces] = await Promise.all([
      WhatsAppEvent.find({}).sort({ at: -1 }).limit(1).lean(),
      WhatsAppEvent.countDocuments({ at: { $gte: dayAgo } }),
      WhatsAppEvent.countDocuments({ redelivery: true, at: { $gte: dayAgo } }),
      OutboxMessage.find({ status: 'sent', sentAt: { $ne: null } }).sort({ sentAt: -1 }).limit(1).lean(),
      WhatsAppEvent.find({}).sort({ at: -1 }).limit(15).lean(),
      Section.find({ 'whatsappGroup.id': { $ne: null } }).select('name whatsappGroup.id whatsappGroup.name').lean(),
      ChatbotSetting.findOne({ key: 'global' }).select('enabled updatedAt geminiKeys aiOutageUntil').lean(),
      // OWNER MANDATE 2026-10-11 (repair evidence): 24h inbound mix by chat
      // type + message type — proves whether DIRECT (teacher 1:1) and MEDIA
      // events reach the webhook at all.
      WhatsAppEvent.aggregate([{ $match: { at: { $gte: dayAgo } } },
        { $group: { _id: { t: '$chatType', m: '$msgType' }, n: { $sum: 1 } } },
        { $sort: { n: -1 } }, { $limit: 25 }]),
      WhatsAppEvent.findOne({ chatType: 'direct' }).sort({ at: -1 }).lean(),
      WhatsAppEvent.find({ chatType: 'direct' }).sort({ at: -1 }).limit(12).lean(),
      // last 5 bot answers — live proof a group reply really went out
      ChatbotLog.find({}).sort({ createdAt: -1 }).limit(5)
        .select('createdAt question reply source error sentFiles').lean(),
      // OWNER SPEC 2026-10-14 Phase 5.2: sanitized delivery-job audit trail —
      // msg ids, per-file states, durations, retries, provider status
      NoteDeliveryJob.find({}).sort({ createdAt: -1 }).limit(10).lean(),
      // OWNER FIX 2026-10-15: recent group-bot trace verdicts (with the
      // sanitized llmFail evidence) — breaker/cooldown and per-model
      // failures become visible in ops-diagnostics.
      WhatsAppEvent.find({ 'groupTrace.why': { $exists: true } })
        .sort({ updatedAt: -1 }).limit(4).select('at groupTrace').lean(),
    ]);
    // CLIENT-ERROR BEACON (2026-10-14): recent browser render-crash
    // reports from the frontend error boundaries — the exact error head
    // from the owner's device, readable remotely via ops-diagnostics.
    const clientErrors = await ClientError.find({}).sort({ at: -1 }).limit(10)
      .select('kind message stackHead componentHead path at').lean();
    // LIVE bot identity: what number does the Wasender session ACTUALLY run
    // on? The chatbot's tag matcher uses env gatewayPhone — if these tails
    // differ, every digit-mention tag misses and the bot stays silent.
    let gatewaySelfTail = null;
    let selfProfile = null;
    try {
      const me = await whatsappService.getSelfProfile?.() ?? {};
      selfProfile = me;
      // JIDs carry a device suffix ("923019670950:9@s.whatsapp.net") — strip
      // it BEFORE digit-extraction or the tail shifts and fakes a mismatch.
      const rawSelf = String(me.wid ?? me.waNumber ?? me.wa_number ?? me.phone
        ?? me.number ?? me.jid ?? me.userJid ?? me.userId ?? me.id ?? '').split(':')[0];
      const digits = rawSelf.replace(/\D/g, '');
      gatewaySelfTail = digits ? digits.slice(-8)
        : 'shape:' + Object.keys(me).join(',').slice(0, 80);
    } catch (err) { gatewaySelfTail = 'unavailable:' + String(err?.message ?? err).slice(0, 60); }

    res.json({ success: true, data: {
      heartbeat: {
        deadlineSweepLastRun: sweepBeat?.lastSentAt ?? null,
        watchdogLastRun: dogBeat?.lastSentAt ?? null,
        watchdogLastRenewal: dogRenew?.lastSentAt ?? null,
        watchdogLastExtendError: dogErr?.value ?? null,
      },
      questions: questions.map((q) => ({ ref: q.refCode, phone: mask(q.phone), status: q.status,
        ageHours: Math.round((now - new Date(q.askedAt).getTime()) / 3600000), nudges: q.crReminders,
        escalatedTo: q.escalatedToName || null, dispatchAttempts: q.crNotifyAttempts,
        // 2026-10-11 repair evidence: what ACTUALLY happened on dispatch
        crNotifiedAt: q.crNotifiedAt ?? null,
        crNotifyError: (q.crNotifyError ?? '') || null,
        crTargetTail: (q.crNotifyTarget ?? '') || null })),
      answersAwaitingDelivery: questions.filter((q) => q.status === 'cr_responded').length,
      materials: materials.map((m) => ({ id: String(m._id).slice(-8), filename: (m.filename ?? '').slice(0, 60),
        status: m.status, ageHours: Math.round((now - new Date(m.updatedAt).getTime()) / 3600000) })),
      crNotifyPending: crNotifyPending.map((m) => ({ id: String(m._id).slice(-8), attempts: m.crNotify?.attempts ?? 0 })),
      outboxFailed: outboxFailed.map((o) => ({ kind: o.kind, refKey: o.refKey, phone: mask(o.phone),
        attempts: o.attempts, lastError: (o.lastError ?? '').slice(0, 120), ageMinutes: Math.round((now - new Date(o.updatedAt).getTime()) / 60000) })),
      classesAwaitingTeacher: awaitingClasses,
      gatewaySelf: gatewaySelfTail, // live Wasender /me tail, see below
      // TEMP 2026-10-11: masked FULL self-profile — key discovery for the
      // bot's LID (digit runs masked to last-4; removed after LID fix lands).
      gatewaySelfDebug: JSON.parse(JSON.stringify(selfProfile ?? {}, (k, v) =>
        typeof v === 'string' ? v.replace(/\d{5,}/g, (m) => `…${m.slice(-4)}`) : v)),
deliveryJobs: (recentDeliveryJobs ?? []).map((j) => ({
        id: j.msgId || String(j._id), status: j.status,
        requester: mask(j.requester), question: String(j.question ?? '').slice(0, 80),
        createdAt: j.createdAt, latencyMs: j.latencyMs ?? null,
        files: (j.files ?? []).map((f) => ({
          state: f.state, attempts: f.attempts,
          durationMs: f.durationMs ?? null,
          providerMsgId: f.providerMsgId || null,
          error: f.error || null,
        })),
      })),
      chatbot: {
        // OWNER 2026-10-11: 'msgs off/on' panel toggle state — if this is
        // false the group bot consumes everything SILENTLY, no matter what
        // else is fixed. env var is only the boot default.
        enabled: chatbotDoc ? chatbotDoc.enabled === true : env.chatbot?.enabled === true,
        dbRowPresent: Boolean(chatbotDoc),
        dbUpdatedAt: chatbotDoc?.updatedAt ?? null,
        geminiKeyConfigured: Boolean(env.chatbot?.googleApiKey),
        // OWNER QUOTA-POOL FIX 2026-10-14: panel-managed key pool state —
        // count + masked tails only, values NEVER leave the server.
        geminiKeysCount: (chatbotDoc?.geminiKeys ?? []).length,
        geminiKeysMasked: (chatbotDoc?.geminiKeys ?? []).map((k) => `…${String(k).slice(-4)}`),
        // OWNER FIX 2026-10-15: breaker state must be VISIBLE — a stuck
        // outage window must never be a guess again.
        aiOutageUntil: chatbotDoc?.aiOutageUntil ?? null,
        tagMatcherSelfTail: String(env.whatsapp?.gatewayPhone ?? '').replace(/\D/g, '').slice(-8) || null,
        // BOT LID TAIL (2026-10-11): group picker-mentions reference the bot
        // by LID, not phone — compare this tail against the mentionTails
        // recorded in group traces (Wasender lid-from-phone, 1h-cached).
        selfLidTail: String((await whatsappService.getLidFromPhone?.(env.whatsapp?.gatewayPhone ?? '')?.catch?.(() => null)) ?? '').replace(/\D/g, '').slice(-8) || null,
      },
      webhook: {
        lastInboundAt: lastEvent[0]?.at ?? null,
        lastInboundFrom: mask(lastEvent[0]?.author || lastEvent[0]?.from),
        lastInboundType: lastEvent[0]?.chatType ?? null,
        inbound24h, redeliveries24h,
        lastDirectAt: lastDirect?.at ?? null,
        lastDirectType: lastDirect?.msgType ?? null,
        recentDirect: recentDirect.map((e) => ({ at: e.at, msgType: e.msgType,
          from: e.from ? `…${String(e.from).replace(/\D/g, '').slice(-4)}` : '',
          redelivery: e.redelivery === true, shape: String(e.rawShape ?? '').slice(0, 220) })),
        byType24h: byType24h.map((r) => ({ kind: `${r._id.t}/${r._id.m}`, count: r.n })),
        botRecent: botRecent.map((b) => ({ at: b.createdAt, q: (b.question ?? '').slice(0, 120),
          a: (b.reply ?? '').slice(0, 160), source: b.source, error: b.error ?? null, sentFiles: b.sentFiles ?? 0 })),
        botTraces: (botTraces ?? []).map((e) => ({ at: e.groupTrace?.at ?? e.at, why: e.groupTrace?.why,
          llmFail: e.groupTrace?.llmFail ? { memoryDropped: e.groupTrace.llmFail.memoryDropped === true,
            fails: (e.groupTrace.llmFail.fails ?? []).map((f) => ({ model: f.model, status: f.status ?? null, finish: f.finish ?? null })) } : undefined })),
        linkedGroups: linkedGroups.map((sec) => ({ section: sec.name, groupId: sec.whatsappGroup?.id?.slice(-14), groupName: sec.whatsappGroup?.name })),
        recentEvents: recentEvents.map((e) => ({ at: e.at, chatType: e.chatType, msgType: e.msgType,
          redelivery: Boolean(e.redelivery), from: String(e.from ?? '').slice(-22), author: String(e.author ?? '').slice(-14),
          shape: String(e.rawShape ?? '').slice(0, 500), botHandled: e.botHandled === true,
          groupTrace: e.groupTrace ?? null })),
      },
      outbound: {
        lastSentAt: lastSentRow[0]?.sentAt ?? null,
        sendSpacingMs: env.whatsapp.sendSpacingMs ?? null,
      },
      clientErrors: clientErrors.map((e) => ({ at: e.at, kind: e.kind, path: e.path,
        message: e.message, stackHead: e.stackHead, componentHead: e.componentHead })),
    } });
  } catch (err) { next(err); }
});

/** TEMP INVESTIGATION ROUTE (2026-10-11 targeted bug audit, owner-requested)
 * — READ-ONLY evidence view: raw webhook events, question/task state, real
 * DB mappings (teachers/CRs/sections), outbox + material pipelines. Same
 * sweep-secret guard as ops-diagnostics. REMOVED once the audit closes. */
router.get('/invdiag', async (req, res, next) => {
  try {
    assertSweepSecret(req);
    const { WhatsAppEvent, TeacherQuestion, TeacherMaterial, Teacher, User, Section, OutboxMessage } = await import('../models/index.js');
    const winH = Math.min(Math.max(Number(req.query.windowHours) || 3, 1), 72);
    const threeHAgo = new Date(Date.now() - winH * 3600 * 1000);
    const [events, questions, materials, outbox, teachers, sections, directEvents, teacherChats] = await Promise.all([
      WhatsAppEvent.find({ at: { $gte: threeHAgo } }).sort({ at: -1 }).limit(200).lean(),
      TeacherQuestion.find({ askedAt: { $gte: new Date(Date.now() - Math.max(winH, 26) * 3600 * 1000) } }).sort({ askedAt: -1 }).limit(60).lean(),
      TeacherMaterial.find({ createdAt: { $gte: threeHAgo } }).sort({ createdAt: -1 }).limit(100).lean(),
      OutboxMessage.find({ updatedAt: { $gte: threeHAgo } }).sort({ updatedAt: -1 }).limit(150).lean(),
      Teacher.find({}).select('name whatsapp subject section').populate('subject', 'name').populate('section', 'name semester').limit(30).lean(),
      Section.find({}).populate('department', 'name').select('name semester department cr gr whatsappGroup').limit(15).lean(),
      // CR-DELIVERY BUG 2026-10-12: teacher/CR 1:1 traffic drowns under ~85
      // group events/hour in the 200-row window — the exact inbound text of
      // a teacher question was never visible. Direct-only feed, last 48h.
      WhatsAppEvent.find({ chatType: 'direct' }).sort({ at: -1 }).limit(150).lean(),
      Teacher.find({}).sort({ updatedAt: -1 }).limit(4).select('name whatsapp updatedAt conversation').lean(),
    ]);
    const crIds = [...new Set([...questions.map((q) => q.crUser), ...sections.map((s) => s.cr), ...sections.map((s) => s.gr)].filter(Boolean))];
    const crs = crIds.length ? await User.find({ _id: { $in: crIds } }).select('name role phone').lean() : [];
    res.json({ success: true, data: {
      // LIVE EVIDENCE (owner spec 2026-10-11 §5): the exact outbound rows the
      // gateway confirmed — masked recipient, status, provider msg id, body.
      recentOutbox: (await OutboxMessage.find({}).sort({ updatedAt: -1 }).limit(14).lean())
        .map((r) => ({ toTail: String(r.phone ?? '').slice(-4), kind: r.kind,
          refKey: (r.refKey ?? '').slice(0, 60), status: r.status,
          providerMsgId: r.providerMsgId || null, attempts: r.attempts ?? 0,
          body: String(r.body ?? '').slice(0, 400) })),
      directEvents: directEvents.map((e) => ({ at: e.at, msgId: String(e.msgId).slice(-14), from: e.from,
        chatType: e.chatType, msgType: e.msgType, redelivery: e.redelivery,
        bodyText: (e.bodyText ?? '').slice(0, 300),
        rawShape: (e.rawShape ?? '').slice(0, 600) })),
      teacherChats: teacherChats.map((t) => ({ name: t.name, phone: t.whatsapp,
        updatedAt: t.updatedAt,
        conversation: (t.conversation ?? []).slice(-24).map((m) => ({ role: m.role, at: m.at,
          text: String(m.text ?? '').slice(0, 220) })) })),
      events: events.map((e) => ({ at: e.at, msgId: String(e.msgId).slice(-14), from: e.from,
        chatType: e.chatType, msgType: e.msgType, redelivery: e.redelivery, rawShape: e.rawShape || null,
        bodyText: (e.bodyText ?? '').slice(0, 160) })),
      questions: questions.map((q) => ({ ref: q.refCode, at: q.askedAt, teacherName: q.teacherName,
        phone: q.phone, section: q.section, crUser: q.crUser, status: q.status,
        attempts: q.crNotifyAttempts, notifiedAt: q.crNotifiedAt ?? null, lastCrAt: q.lastCrNotifyAt ?? null,
        question: String(q.question).slice(0, 80) })),
      materials: materials.map((m) => ({ at: m.createdAt, phone: m.phone,
        filename: String(m.filename ?? '').slice(0, 60), status: m.status, sha: (m.sha256 ?? '').slice(0, 12),
        crNotify: { event: m.crNotify?.event ?? null, status: m.crNotify?.status ?? null,
          attempts: m.crNotify?.attempts ?? 0, lastTriedAt: m.crNotify?.lastTriedAt ?? null },
        publishedNote: m.publishedNote ? String(m.publishedNote).slice(-8) : null,
        askedAt: m.askedAt ?? null, lastReplyMsgId: (m.lastReplyMsgId ?? '').slice(-12),
        lastReply: (m.lastReply ?? '').slice(0, 120),
        audit: (m.audit ?? []).slice(-10).map((a) => ({ at: a.at, event: a.event, detail: (a.detail ?? '').slice(0, 160) })) })),
      outbox: outbox.map((o) => ({ at: o.updatedAt, kind: o.kind, refKey: o.refKey, phone: o.phone,
        status: o.status, attempts: o.attempts, error: String(o.lastError ?? '').slice(0, 150), hasUrl: Boolean(o.url),
        body: String(o.body ?? '').slice(0, 250) })),
      crs,
      teachers: teachers.map((t) => ({ name: t.name, phone: t.whatsapp,
        subject: t.subject?.name ?? null, section: t.section?.name ?? null })),
      sections: sections.map((s) => ({ name: s.name, sem: s.semester, dept: s.department?.name ?? null,
        group: s.whatsappGroup?.id ?? null })),
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
function rawMessageBodyHas(body) {
  return typeof body?.data?.body === 'string' && body.data.body.length > 0;
}

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
    // AUDIT RECORDING 2026-10-11 (owner bug investigation): record the event
    // BEFORE normalization with RAW evidence — remoteJid vs cleanedSenderPn
    // (LID bug), raw message kind (file events), payload structure. Values
    // are redacted: sender digits only, never bodies, never URLs.
    try {
      const { WhatsAppEvent } = await import('../models/index.js');
      const rawMsg = req.body?.data?.messages ?? {};
      const rawKey = rawMsg?.key ?? {};
      const rawMessage = rawMsg?.message ?? {};
      const shapeOf = (v, depth = 0) => {
        if (depth > 4) return '…';
        if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
        if (v && typeof v === 'object') {
          const out = {};
          for (const k of Object.keys(v).slice(0, 30)) out[k] = shapeOf(v[k], depth + 1);
          return out;
        }
        return typeof v;
      };
      const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
      // OWNER INCIDENT 2026-10-12: real captioned media arrives WRAPPED
      // (documentWithCaptionMessage{message:{…}}) — the audit must resolve
      // the real kind through the wrapper, or a lost attachment shows up as
      // the misleading 'messageContextInfo' instead of the media kind.
      const rawKind = (() => {
        const inner = MEDIA_WRAPPERS.reduce((msg, w) => msg?.[w]?.message ?? msg, rawMessage) ?? rawMessage;
        return MEDIA_KEYS.find((k) => inner?.[k] && rawMessage?.[k])?.replace('Message', '')
          ?? (MEDIA_WRAPPERS.some((w) => rawMessage?.[w])
            ? `wrapped:${MEDIA_KEYS.find((k) => inner?.[k])?.replace('Message', '') ?? 'unknown'}`
            : null)
          ?? (rawMessage?.conversation !== undefined || rawMessage?.extendedTextMessage?.text !== undefined
            || rawMessageBodyHas(req.body) ? 'chat'
            : Object.keys(rawMessage)[0] ?? 'unknown');
      })();
      const rawId = String(rawKey?.id ?? req.body?.data?.id ?? '').slice(0, 220);
      const rawFrom = String(rawKey?.remoteJid ?? req.body?.data?.from ?? '').slice(0, 120)
        + (rawKey?.cleanedSenderPn ? ` |pn:${String(rawKey.cleanedSenderPn).slice(0, 18)}` : ' |pn:NONE')
        + (rawKey?.cleanedParticipantPn ? ` |part:${String(rawKey.cleanedParticipantPn).slice(0, 18)}` : '');
      if (rawId) {
        const seen = await WhatsAppEvent.findOne({ msgId: rawId }).lean();
        // what the sender actually typed/sent — the single most important
        // diagnostic for approval-interpretation bugs (owner audit 2026-10-11)
        const innerTyped = MEDIA_WRAPPERS.reduce((msg, w) => msg?.[w]?.message ?? msg, rawMessage) ?? {};
        const typed = String(rawMessage?.conversation
          ?? rawMessage?.extendedTextMessage?.text
          ?? rawMessage?.imageMessage?.caption
          ?? rawMessage?.videoMessage?.caption
          ?? rawMessage?.documentMessage?.caption
          ?? rawMessage?.documentMessage?.fileName
          ?? rawMessage?.audioMessage?.caption
          ?? innerTyped?.imageMessage?.caption
          ?? innerTyped?.videoMessage?.caption
          ?? innerTyped?.documentMessage?.caption
          ?? innerTyped?.documentMessage?.fileName
          ?? '').slice(0, 300);
        await WhatsAppEvent.create({ msgId: rawId, from: rawFrom, author: '',
          chatType: String(rawKey?.remoteJid ?? '').endsWith('@g.us') ? 'group' : 'direct',
          msgType: String(rawKind), redelivery: Boolean(seen),
          rawShape: JSON.stringify(shapeOf(req.body)).slice(0, 1500), bodyText: typed }).catch(() => {});
      }
    } catch { /* audit must never block the flow */ }
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
