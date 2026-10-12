/**
 * OWNER RELIABILITY SPEC (2026-10-09, §5–§8): AI DOES NOT KNOW → ASK THE CR.
 *
 * A teacher question the assistant cannot answer from VERIFIED records is
 * NEVER guessed. It becomes a persistent TeacherQuestion task:
 *
 *   teacher asks → [pending_cr] → CR answers on WhatsApp → [cr_responded]
 *     → answer delivered to the teacher → [answer_sent] → [closed]
 *
 * - The responsible CR comes from the section's REAL cr/gr assignment (never
 *   a random CR) and only ever sees THEIR sections' questions.
 * - Several questions can be open at once — each owns its row + ref code
 *   ('Q-4F7A'); a CR with several pending answers WHICH one (or targets it
 *   with the code).
 * - Re-asking the same unresolved question reuses the task (no CR spam).
 * - The teacher is acknowledged ONLY after dispatch really happened, and
 *   honestly told when it did not (the sweep retries a failed dispatch).
 * - Restart-safe: everything is a persisted task row, recovered by
 *   runTeacherQuestionSweep() on the existing 5-minute cron.
 */
import { randomBytes } from 'node:crypto';
import { normalizePhone, samePhone } from './phoneUtils.js';
import { Section, Teacher, TeacherQuestion, User } from '../models/index.js';
import { sendText, sendTracked, sendCrTracked, cleanWhatsAppField, isRateLimitError } from './whatsappService.js';
import { createNotification } from './notificationService.js';

const REUSE_WINDOW_MS = 12 * 60 * 60 * 1000; // same unresolved question reuses its task
const CR_RETRY_MAX = 6; // bounded WhatsApp dispatch retries (sweep)
const CR_RETRY_EVERY_MS = 5 * 60 * 1000;
const CR_SLOW_RETRY_MS = 60 * 60 * 1000; // backoff tier (owner spec item 8): after cap, hourly
const CR_SLOW_RETRY_MAX = 24; // absolute ceiling for the slow tier
/* OWNER GROUP-INTELLIGENCE SPEC §A (2026-10-11) — ONE REMINDER ONLY:
 * after the configured waiting period with no CR answer, send exactly ONE
 * follow-up reminder, then stay silent forever — no second nudge, no
 * automatic GR escalation, no per-scheduler-run repeats. The task stays
 * pending until the CR answers, it is manually reopened, or an authorized
 * user explicitly asks for another reminder. The reminder is claimed
 * atomically (reminderSent=true BEFORE dispatch) so repeated sweep runs,
 * deployments or duplicate webhook events can never resend it; a failed
 * gateway dispatch is retried by the OUTBOX (same dedupe key), not by a
 * new reminder. Waiting period stays the configured 30 min default. */
const FOLLOWUP_WAIT_MINUTES = (() => {
  const first = String(process.env.QUESTION_FOLLOWUP_MINUTES ?? '30')
    .split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return first[0] ?? 30;
})();
const PLEASANTRY_RE = /^(ji|g|ok|okay|acha|achha|theek|theek hai|haan|han|yes|no|nahi|nahin|hmm+k|salam|assalam[^ ]*|hello|hi|thanks|shukriya|jazakallah|good|great|nice|sorry|ok ji|ji ok)[\s.!,.]*$/i;

/** A CR reply that carries no actual answer content ("ok ji", "haan") must
 * NOT be treated as the answer (spec §5) — ask the CR for the real content
 * instead of inventing or delivering a non-answer. */
function isMeaningfulAnswer(text) {
  const stripped = String(text ?? '').replace(PLEASANTRY_RE, '').trim();
  return stripped.length >= 5 && /[a-z0-9؀-\u06FF]/i.test(stripped);
}

function qlog(event, { phone, code, msg } = {}) {
  const masked = phone ? `…${String(phone).slice(-4)}` : '—';
  console.log(`[teacher-question ${new Date().toISOString()}]`, event,
    `phone=${masked}`, code ? `q=${code}` : '', msg ? `msg=${JSON.stringify(String(msg).slice(0, 120))}` : '');
}

function normalizeKey(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function uniqueRefCode() {
  for (let i = 0; i < 5; i += 1) {
    const code = `Q-${randomBytes(2).toString('hex').toUpperCase()}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await TeacherQuestion.exists({ refCode: code }))) return code;
  }
  return `Q-${Date.now().toString(16).slice(-4).toUpperCase()}`;
}

/* ------------------------------ messages -------------------------------- */

/* OWNER SPEC 2026-10-11 (professional short CR notifications):
 * short, respectful, action-oriented, real newlines between sections. */
function crQuestionAlert({ teacherName, sectionLabel, question, refCode }) {
  const q = cleanWhatsAppField(question, 300);
  return [
    `Sir, ${cleanWhatsAppField(teacherName)} ka sawal hai:`,
    '',
    `"${q}"${refCode ? ` (${refCode})` : ''}`,
    '',
    'Jab mumkin ho, jawab de dein.',
  ].join('\n');
}

/* CR-DELIVERY BUG 2026-10-12 live follow-up: acks/answers addressed 'Sir' to
 * a female teacher (Ma'am Hafsa) — the salutation now follows the teacher's
 * own name/title so the professional tone spec survives female teachers. */
function salutationOf(name) {
  return /\b(ma'?am|madam|miss|mrs|ms\.?)\b/i.test(String(name ?? '')) ? "Ma'am" : 'Sir';
}

function teacherAckMessage({ teacherName, crName, delivered }) {
  // OWNER STYLE SPEC 2026-10-11 §1/§5: one concise ack, honest about
  // dispatch state, no footer, no 'correct information' phrasing.
  const s = salutationOf(teacherName);
  if (delivered) {
    return `${s}, yeh detail main ne aap ke CR se confirm karne ke liye bhej di hai. Jawab milte hi bata dunga.`;
  }
  return `${s}, sawal note kar liya hai — CR ko bhejne mein masla aa raha hai, thori dair mein retry karta hoon.`;
}

function teacherAnswerMessage({ teacherName, crName, question, answer }) {
  // OWNER STYLE SPEC 2026-10-11: one concise delivered answer.
  const s = salutationOf(teacherName);
  return [
    `${s}, aap ke sawal ("${String(question ?? '').slice(0, 100)}") ka jawab ${crName ?? 'aap ke CR'} ne bheja hai: "${String(answer ?? '').slice(0, 600)}"`,
  ].join('\n');
}

/* ----------------------------- escalation -------------------------------- */

/** Create (or reuse) a pending CR-confirmation task for a teacher question
 * and dispatch it to the responsible CR. NEVER throws; returns the task.
 * The teacher ack is the CALLER's decision — escalate() only dispatches. */
export async function escalateTeacherQuestion({ sender, payload, teacherDoc, sectionId, crDoc, question, escalatedBy = 'general-chat' }) {
  const questionKey = normalizeKey(question);
  // spec §8: the SAME unresolved question reuses its task — never two rows.
  // OWNER UPGRADE 2026-10-12 §7: group-student askers have no Teacher record
  // (teacherDoc._id null) — their reuse key is the ASKER'S PHONE, so a
  // re-ask reuses the task while a different student gets their own.
  const reuseQuery = teacherDoc?._id
    ? { teacher: teacherDoc._id, status: { $in: ['pending_cr', 'cr_responded'] }, questionKey }
    : { phone: sender, status: { $in: ['pending_cr', 'cr_responded'] }, questionKey };
  const existing = await TeacherQuestion.findOne(reuseQuery).sort({ askedAt: -1 }).lean();
  if (existing && Date.now() - new Date(existing.askedAt).getTime() < REUSE_WINDOW_MS) {
    return { task: existing, reused: true, delivered: Boolean(existing.crNotifiedAt), crName: existing.crName ?? null };
  }
  const refCode = await uniqueRefCode();
  const crUser = crDoc ?? await User.findOne({ role: 'admin' }).sort({ createdAt: 1 }).select('name role phone').lean();
  let task;
  try {
    task = await TeacherQuestion.create({
      teacher: teacherDoc?._id ?? null, teacherName: teacherDoc.name ?? '', phone: sender,
      section: sectionId ?? teacherDoc?.section?._id ?? teacherDoc?.section ?? undefined,
      question: String(question ?? '').slice(0, 800), questionKey, refCode,
      crUser: crUser?._id ?? null, escalatedBy,
    });
  } catch (e) {
    // CR-DELIVERY BUG 2026-10-12 (owner mandate): "NEVER throws" is now
    // literal — a task-creation failure returns { failed } so the caller can
    // tell the teacher honestly instead of leaving a promise nothing keeps.
    qlog('CREATE-FAILED', { phone: sender, code: refCode, msg: String(e?.message ?? e).slice(0, 160) });
    return { task: null, failed: true, error: String(e?.message ?? e).slice(0, 200) };
  }
  qlog('ESCALATED', { phone: sender, code: refCode, msg: question });
  const dispatch = await dispatchToCr(task, crUser);
  return { task, reused: false, delivered: dispatch.delivered, crName: dispatch.crName };
}

/** Best-effort WhatsApp dispatch to the CR; delivery state is persisted so
 * the sweep can retry without creating a second task. */
async function dispatchToCr(task, crUserIn) {
  const crUser = crUserIn ?? (task.crUser ? await User.findById(task.crUser).select('name role phone').lean() : null);
  const sec = task.section ? await Section.findById(task.section).populate('department', 'name').select('name semester department').lean() : null;
  const sectionLabel = sec ? `${sec.department?.name ?? ''} · Semester ${sec.semester ?? ''} · Section ${sec.name ?? ''}` : '—';
  const alert = crQuestionAlert({ teacherName: task.teacherName || 'Teacher', sectionLabel, question: task.question, refCode: task.refCode });
  let delivered = false;
  // 2026-10-11 fix: CR phones stored local ('03088787753') — Wasender needs E.164.
  const crPhone = crUser?.phone ? normalizePhone(crUser.phone) : null;
  let sendErr = '';
  if (crPhone) {
    try {
      const out = await sendCrTracked(crPhone, alert, {
        kind: 'cr_question', refKey: `q-dispatch:${task._id}` });
      delivered = Boolean(out?.sent || out?.alreadySent);
      if (!delivered && out?.error) sendErr = out.error; // rate-limit text must reach isRateLimitError
    } catch (e) { sendErr = String(e?.message ?? e); }
  }
  // portal inbox too (deduped) — the passive channel is never lost
  if (crUser?._id) {
    await createNotification({
      recipient: crUser._id, type: 'system',
      title: `Teacher question needs your answer: ${task.refCode}`,
      message: `${task.teacherName || 'A teacher'} asked: "${String(task.question).slice(0, 300)}" — reply on WhatsApp so Tri3M can answer them.`,
      refType: 'section', refId: task.section,
      dedupeKey: `teacher-question:${String(task._id).slice(-12)}`,
    }).catch(() => {});
  }
  await TeacherQuestion.updateOne({ _id: task._id }, {
    $set: {
      crUser: crUser?._id ?? task.crUser ?? null,
      lastCrNotifyAt: new Date(),
      // OWNER MANDATE 2026-10-11 (repair evidence): the dispatch's REAL
      // failure reason and the resolved recipient (masked tail-4 only) are
      // PERSISTED — a silently climbing attempt counter is never again the
      // only symptom the admin can see.
      crNotifyError: delivered ? '' : String(sendErr || (crPhone
        ? 'gateway did not confirm send'
        : 'no CR phone on file')).slice(0, 200),
      crNotifyTarget: crPhone ? String(crPhone).slice(-4) : null,
      ...(delivered ? { crNotifiedAt: new Date() } : {}),
    },
    // throttled by the provider plan (Wasender trial 1 send/min) is NOT a
    // delivery failure — it must not burn the bounded CR dispatch attempts.
    $inc: (delivered || !isRateLimitError(sendErr)) ? { crNotifyAttempts: 1 } : {},
  }).catch(() => {});
  qlog(delivered ? 'CR-NOTIFIED' : 'CR-NOTIFY-FAILED', { phone: crPhone ?? '—', code: task.refCode });
  return { delivered, crName: crUser?.name, rateLimited: !delivered && isRateLimitError(sendErr) };
}

/* --------------------------- teacher ack (§6) ----------------------------- */

/** Acknowledge the teacher HONESTLY: only claim the forward happened when
 * the CR dispatch really succeeded. Idempotent per ack message id. */
export async function ackEscalatedTeacher({ sender, payload, task, crName, delivered }) {
  const msgId = String(payload?.data?.id ?? '').slice(0, 220);
  if (task.teacherAckMsgId && task.teacherAckMsgId === msgId) return; // redelivery
  const ack = teacherAckMessage({ teacherName: task.teacherName, crName, delivered });
  await sendTracked(sender, ack, { kind: 'ack', refKey: `question:${task._id}:ack:${msgId}`, once: true, dedupeKey: `q-ack:${task._id}:${msgId}` });
  await TeacherQuestion.updateOne({ _id: task._id }, { $set: { teacherAckMsgId: msgId } }).catch(() => {});
  qlog('TEACHER-ACKED', { phone: sender, code: task.refCode, msg: delivered ? 'forwarded' : 'dispatch pending' });
}

/* --------------------------- CR reply intake (§7) -------------------------- */

/** An inbound WhatsApp message from a CR/GR answering a pending teacher
 * question. Returns true when consumed, false when this message is not a
 * CR-answer (the rest of the webhook pipeline continues unchanged). */
export async function handleCrQuestionReply(sender, body, payload) {
  const msgId = String(payload?.data?.id ?? '').slice(0, 220);
  let text = String(body ?? '').trim();
  if (!msgId || !sender || !text) return false;
  // 2026-10-11 fix: inbound sender is ALWAYS E.164 digits; stored phones may
  // be local format. Regex equality never matched both — CR replies were
  // misclassified as teacher messages. Match on normalized identity instead.
  const allLeaders = await User.find({ role: { $in: ['cr', 'gr'] } }).select('_id name role phone').lean();
  const users = allLeaders.filter((u) => samePhone(sender, u.phone));
  if (!users.length) return false;
  const ids = users.map((u) => u._id);
  let pending = await TeacherQuestion.find({ crUser: { $in: ids }, status: { $in: ['pending_cr', 'cr_responded'] } }).sort({ askedAt: 1 }).lean();
  if (!pending.length) return false; // a CR texting the bot with nothing open — not ours
  // explicit ref-code targeting: "Q-4F7A jawab hai..."
  const codeMatch = /Q-([A-F0-9]{4})/i.exec(text);
  if (codeMatch) {
    const target = pending.find((q) => q.refCode.toUpperCase() === `Q-${codeMatch[1].toUpperCase()}`);
    if (target) {
      pending = [target];
      text = text.replace(codeMatch[0], '').trim();
    } else {
      await sendText(sender, `Ye code samajh nahi aya — mere paas in sawalon ka jawab pending hai: ${pending.map((q) => q.refCode).join(', ')}. Code likh kar bata dein.`).catch(() => {});
      return true;
    }
  }
  if (pending.length > 1) { // several open questions — WHICH one is this for?
    await sendText(sender, [
      `Aap ke ${pending.length} sawal pending hain — kis ka jawab ye hai? Code likh kar bhej dein:`,
      ...pending.map((q) => `*${q.refCode}*: "${String(q.question).slice(0, 80)}"`),
    ].join('\n')).catch(() => {});
    return true;
  }
  const task = pending[0];
  if (task.crReplyMsgId && task.crReplyMsgId === msgId) return true; // redelivery — already processed
  // spec §5: an unclear/non-answer gets a clarification ask, never a fake
  // delivery. Only a reply with real content becomes the answer.
  if (!isMeaningfulAnswer(text)) {
    await sendTracked(sender, [
      `JazakAllah! Lekin is sawal ka jawab to abhi chahiye:`,
      `*${task.refCode}*: "${String(task.question).slice(0, 120)}"`,
      '',
      'Thora detail mein jawab bhej dein — main teacher ko wahi pohancha dunga.',
      '',
      '— Tri3M Class Agent',
    ].join('\n'), { kind: 'cr_clarify', refKey: `question:${task._id}:clarify:${msgId}`, once: true, dedupeKey: `q-clarify:${task._id}:${msgId}` });
    qlog('CR-CLARIFY-ASKED', { phone: sender, code: task.refCode, msg: text });
    return true;
  }
  // store the CR's answer with identity + timestamp BEFORE delivering
  await TeacherQuestion.updateOne({ _id: task._id }, { $set: {
    crReply: text.slice(0, 1200), crReplyMsgId: msgId, crReplyAt: new Date(),
    crUser: task.crUser ?? users[0]._id, status: 'cr_responded' } });
  qlog('CR-REPLIED', { phone: sender, code: task.refCode, msg: text });
  const crUser = users[0];
  const answer = teacherAnswerMessage({ teacherName: task.teacherName, crName: crUser?.name ?? task.crName ?? 'the CR', question: task.question, answer: text });
  // tracked send: a temporary WhatsApp failure leaves a retryable outbox row
  const delivered = await sendTracked(task.phone, answer, {
    kind: 'answer', refKey: `question:${task._id}:answer`, once: true, dedupeKey: `q-answer:${task._id}` });
  if (delivered.sent) { // spec: closed ONLY after successful delivery
    await TeacherQuestion.updateOne({ _id: task._id }, { $set: {
      status: 'closed', answerSentAt: new Date(), closedAt: new Date() } });
    qlog('ANSWER-SENT', { phone: task.phone, code: task.refCode });
  } else {
    qlog('ANSWER-SEND-FAILED', { phone: task.phone, code: task.refCode, msg: delivered.error });
    // stays cr_responded — the outbox sweep re-delivers the stored answer
  }
  return true;
}

/* ------------------------------- sweep (§9) -------------------------------- */

/** 5-minute cron: (1) re-dispatch questions whose CR ping failed, (2) one
 * bounded reminder for unanswered questions, (3) re-deliver stored CR
 * answers whose teacher ping failed. NEVER throws. */
export async function runTeacherQuestionSweep() {
  const out = { redispatched: 0, reminders: 0, redelivered: 0, escalated: 0 };
  try {
    const now = Date.now();
    // 1) dispatch retry
    // 2026-10-11 BACKOFF: fast tier = 6 attempts every 5 min; slow tier =
    // hourly up to CR_SLOW_RETRY_MAX (questions throttled to death by the
    // pre-guard trial burns get resurrected by the slow tier instead of
    // being lost forever).
    const undelivered = await TeacherQuestion.find({ status: 'pending_cr', crNotifiedAt: null,
      $or: [
        { crNotifyAttempts: { $lt: CR_RETRY_MAX },
          $or: [{ lastCrNotifyAt: null }, { lastCrNotifyAt: { $lt: new Date(now - CR_RETRY_EVERY_MS) } }] },
        { crNotifyAttempts: { $gte: CR_RETRY_MAX, $lt: CR_SLOW_RETRY_MAX },
          $or: [{ lastCrNotifyAt: null }, { lastCrNotifyAt: { $lt: new Date(now - CR_SLOW_RETRY_MS) } }] },
      ] }).limit(8).lean();
    for (const t of undelivered) {
      const r = await dispatchToCr(t); out.redispatched++;
      if (r?.rateLimited) break; // throttled plan — further sends this pass would 429
    }
    // 2) OWNER SPEC §A (2026-10-11) — ONE REMINDER ONLY: after the wait,
    //    atomically claim reminderSent BEFORE dispatch (repeated jobs,
    //    deployments or duplicate events can never resend), then let the
    //    outbox safely retry a failed delivery. No second reminder, no
    //    automatic GR escalation — the task simply stays pending.
    // LEGACY SAFE-GUARD: questions that already received nudges under the
    // OLD 30m+2h policy (crReminders > 0) are considered reminded — the new
    // policy never fires an EXTRA reminder on top of them.
    const openTasks = await TeacherQuestion.find({ status: 'pending_cr', crNotifiedAt: { $ne: null },
      reminderSent: { $ne: true }, crReminders: 0 })
      .sort({ askedAt: 1 }).limit(40).lean();
    for (const t of openTasks) {
      const ageMs = now - new Date(t.askedAt).getTime();
      if (ageMs < FOLLOWUP_WAIT_MINUTES * 60 * 1000) continue;
      const crPhone = t.crUser ? (await User.findById(t.crUser).select('phone').lean())?.phone : null;
      // atomic claim — the FIRST sweep pass to flip reminderSent owns the
      // reminder; every later pass/redelivery skips silently
      const claimed = await TeacherQuestion.findOneAndUpdate(
        { _id: t._id, status: 'pending_cr', reminderSent: { $ne: true }, crReminders: 0 },
        { $set: { reminderSent: true, lastFollowUpAt: new Date() }, $inc: { crReminders: 1 } },
        { new: true }).lean();
      if (!claimed) continue;
      if (crPhone) {
        await sendCrTracked(normalizePhone(crPhone),
          [
            `Sir, ${cleanWhatsAppField(t.teacherName)} ka sawal abhi pending hai:`,
            '',
            `"${cleanWhatsAppField(t.question, 100)}" (${t.refCode})`,
            '',
            'Jab mumkin ho, jawab de dein.',
          ].join('\n'),
          { kind: 'cr_nudge', refKey: `question:${t._id}:reminder`, dedupeKey: `q-reminder:${t._id}` });
      }
      out.reminders++;
      continue;
    }
    // 3) a stored CR answer that never reached the teacher — the OUTBOX row
    //    is the retry vehicle: close only when delivery really succeeded.
    const unsentAnswers = await TeacherQuestion.find({ status: 'cr_responded' }).limit(20).lean();
    for (const t of unsentAnswers) {
      const { OutboxMessage } = await import('../models/index.js');
      const row = await OutboxMessage.findOne({ refKey: `question:${t._id}:answer` }).sort({ updatedAt: -1 }).lean();
      if (row?.status === 'sent') {
        await TeacherQuestion.updateOne({ _id: t._id }, { $set: {
          status: 'closed', answerSentAt: row.sentAt ?? new Date(), closedAt: new Date() } });
        out.redelivered++;
      } else if (!row) { // crash before any outbox row existed
        const delivered = await sendTracked(t.phone,
          teacherAnswerMessage({ teacherName: t.teacherName, crName: t.crName ?? 'the CR', question: t.question, answer: t.crReply }),
          { kind: 'answer', refKey: `question:${t._id}:answer`, once: true, dedupeKey: `q-answer:${t._id}` });
        if (delivered.sent) {
          await TeacherQuestion.updateOne({ _id: t._id }, { $set: {
            status: 'closed', answerSentAt: new Date(), closedAt: new Date() } });
          out.redelivered++;
        }
      } // row failed → the outbox sweep retries it; we close it next pass
    }
  } catch (err) { console.error('[teacher-question sweep]', err?.message ?? err); }
  return out;
}
