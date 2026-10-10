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
import { Section, Teacher, TeacherQuestion, User } from '../models/index.js';
import { sendText, sendTracked } from './whatsappService.js';
import { createNotification } from './notificationService.js';

const REUSE_WINDOW_MS = 12 * 60 * 60 * 1000; // same unresolved question reuses its task
const CR_RETRY_MAX = 6; // bounded WhatsApp dispatch retries (sweep)
const CR_RETRY_EVERY_MS = 5 * 60 * 1000;
/* OWNER RELIABILITY SPEC §4 (2026-10-10): configurable, BOUNDED follow-up
 * policy — a CR question never silently dies. Defaults: gentle nudge after
 * 30 min, a firmer nudge after 2 h, ESCALATION to the section's GR (or the
 * admin) after 6 h. All intervals configurable via env, all attempts
 * persisted; after that the task stays pending and monitored forever. */
const FOLLOWUP_MINUTES = String(process.env.QUESTION_FOLLOWUP_MINUTES ?? '30,120')
  .split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);
const ESCALATE_AFTER_MINUTES = Number(process.env.QUESTION_ESCALATE_MINUTES ?? 360) || 360;
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

function crQuestionAlert({ teacherName, sectionLabel, question, refCode }) {
  return [
    `Assalam-o-Alaikum! Aap ke section ke teacher *${teacherName}* ne ek aisa sawal poocha hai jis ka jawab main confirmed nahi kar sakta.`,
    '',
    `Section: ${sectionLabel}`,
    `Sawal: "${String(question ?? '').slice(0, 300)}"`,
    '',
    `Jawab isi number par reply kar dein${refCode ? ` (ya "*${refCode}* <jawab>" likh kar specific sawal ka)"` : ''} — main teacher tak pohancha dunga.`,
    '',
    '— Tri3M Class Agent',
  ].join('\n');
}

function teacherAckMessage({ crName, delivered }) {
  if (delivered) {
    return [
      'Sir, main aap ko correct information dena chahta hoon — is liye aap ka sawal aap ke relevant CR ko confirm karne bhej diya hai.',
      'Jawab milte hi main aap ko foran bata dunga.',
      '',
      '— Tri3M Class Agent',
    ].join('\n');
  }
  return [
    'Sir, aap ka sawal note kar liya hai — CR ko bhejne mein masla aa raha hai, main dobara try kar raha hoon.',
    'Jawab milte hi aap ko bata dunga.',
    '',
    '— Tri3M Class Agent',
  ].join('\n');
}

function teacherAnswerMessage({ crName, question, answer }) {
  return [
    `Sir, aap ke sawal ka jawab ${crName ?? 'aap ke CR'} ne confirm kar ke bheja hai:`,
    '',
    `Sawal: "${String(question ?? '').slice(0, 120)}"`,
    '',
    `Jawab: "${String(answer ?? '').slice(0, 600)}"`,
    '',
    '— Tri3M Class Agent',
  ].join('\n');
}

/* ----------------------------- escalation -------------------------------- */

/** Create (or reuse) a pending CR-confirmation task for a teacher question
 * and dispatch it to the responsible CR. NEVER throws; returns the task.
 * The teacher ack is the CALLER's decision — escalate() only dispatches. */
export async function escalateTeacherQuestion({ sender, payload, teacherDoc, sectionId, crDoc, question, escalatedBy = 'general-chat' }) {
  const questionKey = normalizeKey(question);
  // spec §8: the SAME unresolved question reuses its task — never two rows
  const existing = await TeacherQuestion.findOne({ teacher: teacherDoc._id,
    status: { $in: ['pending_cr', 'cr_responded'] }, questionKey }).sort({ askedAt: -1 }).lean();
  if (existing && Date.now() - new Date(existing.askedAt).getTime() < REUSE_WINDOW_MS) {
    return { task: existing, reused: true, delivered: Boolean(existing.crNotifiedAt), crName: existing.crName ?? null };
  }
  const refCode = await uniqueRefCode();
  const crUser = crDoc ?? await User.findOne({ role: 'admin' }).sort({ createdAt: 1 }).select('name role phone').lean();
  const task = await TeacherQuestion.create({
    teacher: teacherDoc._id, teacherName: teacherDoc.name ?? '', phone: sender,
    section: sectionId ?? teacherDoc?.section?._id ?? teacherDoc?.section ?? undefined,
    question: String(question ?? '').slice(0, 800), questionKey, refCode,
    crUser: crUser?._id ?? null, escalatedBy,
  });
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
  const crPhone = crUser?.phone ? String(crUser.phone).replace(/\D/g, '') : null;
  if (crPhone) delivered = Boolean((await sendText(crPhone, alert).catch(() => null))?.sent);
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
      ...(delivered ? { crNotifiedAt: new Date() } : {}),
    },
    $inc: { crNotifyAttempts: 1 },
  }).catch(() => {});
  qlog(delivered ? 'CR-NOTIFIED' : 'CR-NOTIFY-FAILED', { phone: crPhone ?? '—', code: task.refCode });
  return { delivered, crName: crUser?.name };
}

/* --------------------------- teacher ack (§6) ----------------------------- */

/** Acknowledge the teacher HONESTLY: only claim the forward happened when
 * the CR dispatch really succeeded. Idempotent per ack message id. */
export async function ackEscalatedTeacher({ sender, payload, task, crName, delivered }) {
  const msgId = String(payload?.data?.id ?? '').slice(0, 220);
  if (task.teacherAckMsgId && task.teacherAckMsgId === msgId) return; // redelivery
  const ack = teacherAckMessage({ crName, delivered });
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
  const users = await User.find({ phone: { $regex: `^\\+?${sender.replace(/^0+/, '')}$` }, role: { $in: ['cr', 'gr'] } }).select('_id name role phone').lean();
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
  const answer = teacherAnswerMessage({ crName: crUser?.name ?? task.crName ?? 'the CR', question: task.question, answer: text });
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
    const undelivered = await TeacherQuestion.find({ status: 'pending_cr', crNotifiedAt: null,
      crNotifyAttempts: { $lt: CR_RETRY_MAX },
      $or: [{ lastCrNotifyAt: null }, { lastCrNotifyAt: { $lt: new Date(now - CR_RETRY_EVERY_MS) } }] }).limit(20).lean();
    for (const t of undelivered) {
      await dispatchToCr(t); out.redispatched++;
    }
    // 2) SPEC §4 follow-up policy: gentle nudge at FOLLOWUP_MINUTES[0],
    //    firmer nudge at [1], then ESCALATION to the section's GR (fallback:
    //    the admin) after ESCALATE_AFTER_MINUTES. All bounded + persisted.
    const openTasks = await TeacherQuestion.find({ status: 'pending_cr', crNotifiedAt: { $ne: null } })
      .sort({ askedAt: 1 }).limit(40).lean();
    for (const t of openTasks) {
      const ageMs = now - new Date(t.askedAt).getTime();
      const crPhone = t.crUser ? (await User.findById(t.crUser).select('phone').lean())?.phone : null;
      if (t.crReminders < FOLLOWUP_MINUTES.length && ageMs >= FOLLOWUP_MINUTES[t.crReminders] * 60 * 1000) {
        const first = t.crReminders === 0;
        if (crPhone) {
          await sendTracked(String(crPhone).replace(/\D/g, ''),
            first
              ? `Assalam-o-Alaikum! Teacher ke sawal (*${t.refCode}*) ka jawab abhi tak nahi mila — "${String(t.question).slice(0, 100)}". Jab foran ho jaye to bata dein, teacher intezar kar rahay hain. Shukriya!\n\n— Tri3M Class Agent`
              : `Teacher ab bhi jawab ka intezar kar rahay hain (*${t.refCode}*) — "${String(t.question).slice(0, 100)}". Aaj hi jawab de dein, main teacher tak pohancha dunga.\n\n— Tri3M Class Agent`,
            { kind: 'cr_nudge', refKey: `question:${t._id}:nudge${t.crReminders}`, once: true, dedupeKey: `q-nudge:${t._id}:${t.crReminders}` });
        }
        await TeacherQuestion.updateOne({ _id: t._id }, { $inc: { crReminders: 1 }, $set: { lastFollowUpAt: new Date() } }).catch(() => {});
        out.reminders++;
      } else if (t.crReminders >= FOLLOWUP_MINUTES.length && !t.escalatedAt && ageMs >= ESCALATE_AFTER_MINUTES * 60 * 1000) {
        // escalate: the section's GR first, then the platform admin
        const sec = t.section ? await Section.findById(t.section).select('cr gr name').lean() : null;
        const target = (sec?.gr && (!t.crUser || String(sec.gr) !== String(t.crUser)))
          ? await User.findById(sec.gr).select('name role phone').lean()
          : await User.findOne({ role: 'admin' }).sort({ createdAt: 1 }).select('name role phone').lean();
        if (target?.phone) {
          await sendTracked(String(target.phone).replace(/\D/g, ''),
            `Assalam-o-Alaikum! Section ke teacher ka ek sawal CR se ${Math.round(ageMs / 3600000)} ghante se pending hai (code *${t.refCode}*). GR hone ke nate aap isay CR se confirm karwa dein:\n\nSawal: "${String(t.question).slice(0, 200)}"\n\nJawab milte hi main teacher tak pohancha dunga.\n\n— Tri3M Class Agent`,
            { kind: 'escalation', refKey: `question:${t._id}:escalation`, once: true, dedupeKey: `q-escalate:${t._id}` });
        }
        if (target?._id) {
          await createNotification({
            recipient: target._id, type: 'system',
            title: `Teacher question ${t.refCode} needs escalation`,
            message: `The CR has not answered: "${String(t.question).slice(0, 200)}". Please get it answered — the teacher is waiting.`,
            refType: 'section', refId: t.section,
            dedupeKey: `teacher-question-escalation:${String(t._id).slice(-12)}`,
          }).catch(() => {});
        }
        await TeacherQuestion.updateOne({ _id: t._id }, { $set: {
          escalatedToUser: target?._id ?? null, escalatedToName: target?.name ?? '',
          escalatedAt: new Date(), escalationNote: 'CR unresponsive after nudges; escalated per spec §4' } }).catch(() => {});
        out.escalated = (out.escalated ?? 0) + 1;
      }
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
          teacherAnswerMessage({ crName: t.crName ?? 'the CR', question: t.question, answer: t.crReply }),
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
