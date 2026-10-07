import { randomBytes } from 'node:crypto';
import { Section, Subject, Teacher, Timetable, User } from '../models/index.js';
import { env } from '../config/env.js';
import { isConfigured, sendText } from './whatsappService.js';

const MAX_ATTEMPTS = 3;

/* Owner request (2026-10-02): teachers sometimes answer with a sentence
 * ("yes betha ma aaon ga") instead of a bare YES/NO — the agent used to
 * stay silent and the question went nowhere. Unrecognized replies from a
 * teacher with an open question now get ONE polite reminder that this is
 * one polite reminder — OWNER REWRITE (2026-10-07): the teacher must feel
 * a HUMAN is texting, never robot talk ('I am an AI agent' is banned).
 * This is only the OFFLINE fallback; the live path answers like a person.
 * Throttled so repeated messages never spam, and it never answers,
 * re-queues or retries the underlying question. */
const HINT_COOLDOWN_MS = 2 * 60 * 1000;

const HINT_POOLS = [
  "Sorry, aap ka paighaam samajh nahi aa saka. Class ka status students tak pohanchane ke liye sirf ek plain *YES* or *NO* likh dein.",
  "Maazrat — aap ka matlab theek se samajh nahi aaya. Class hogi to plain *YES* or *NO* likh dein, students ko foran status nazar aa jata hai.",
  "Sorry for the confusion — I could not follow your last message. A plain *YES* or *NO* reply updates the class status for your students right away.",
  "Aap ka paighaam clear nahi hua. Sirf ek plain *YES* or *NO* likh dein — YES matlab aap class leinge, NO matlab aap nahi aa sakte.",
];

/** Random pick so repeated reminders never read identical. Exported for tests.
 * Human voice (owner 2026-10-07): reads like a student politely asking the
 * teacher for a one-word answer — short, no AI/robot claims, no heavy
 * signature, exactly how a person texts. */
export function buildHintMessage(teacherName) {
  const line = HINT_POOLS[Math.floor(Math.random() * HINT_POOLS.length)];
  return [
    `Assalam-o-Alaikum Respected *${teacherName || 'Teacher'}*!`,
    '',
    line,
    '',
    '— Tri3M Class Agent',
  ].join('\n');
}
const BATCH_SIZE = 3; // existing external 5-minute pinger, no new jobs or Base44 usage
const fmtDate = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Karachi' });
const clean = (value, max = 65) => String(value ?? '').replace(/[\r\n\t*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const bold = (value, max = 65) => `*${clean(value, max)}*`;
const PORTAL_URL = process.env.APP_URL || 'https://www.tri2m.com' // custom domain live 2026-10-05 (was iubcr.vercel.app);

/** PKT-relative label so the greeting line never lies about the day. */
const relativeDay = (dateStr) => {
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const diff = Math.round((new Date(`${dateStr}T12:00:00Z`).getTime() - new Date(`${todayStr}T12:00:00Z`).getTime()) / 86_400_000);
  if (diff === 0) return 'for today';
  if (diff === 1) return 'for tomorrow';
  return `on ${fmtDate.format(new Date(`${dateStr}T12:00:00+05:00`)).split(',')[0]}`;
};
const fmtTime = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
};

/** A short per-revision reference disambiguates teachers with multiple pending
 * classes. Plain YES/NO is accepted only for one timely request from that
 * same linked teacher phone. */
export function buildTeacherMessage({ section, department, teacher, subject, author, slot, code }) {
  const day = fmtDate.format(new Date(`${slot.date}T12:00:00+05:00`));
  const authorRole = author?.role === 'gr' ? 'GR' : author?.role === 'admin' ? 'Admin' : 'CR';
  const room = clean(slot.room, 40);
  return [
    '*Tri3M Class Agent*',
    'AI-Powered Class Management Assistant',
    '',
    `Assalam-o-Alaikum Respected ${bold(teacher.name)},`,
    '',
    `I am ${bold(author?.name)}, ${authorRole} of ${bold(section.name, 25)}.`,
    '',
    `🎓 Department: ${bold(department?.name)}`,
    `📚 Semester: ${bold(String(section.semester))}`,
    `🏫 Section: ${bold(section.name, 25)}`,
    '',
    `Your ${bold(subject.name)} lecture is scheduled ${relativeDay(slot.date)}:`,
    '',
    `📅 ${day} | 🕐 ${fmtTime(slot.startTime)} – ${fmtTime(slot.endTime)}${room ? ` | 📍 ${room}` : ''}`,
    '',
    'Kindly confirm whether you will be conducting the lecture.',
    '',
    'Please reply *YES* or *NO*.',
    '',
    'Thank you for your cooperation.',
    'JazakAllah Khair.',
    '',
    '— Tri3M Class Agent',
    'Developed by the students of the AI Department, IUB',
    'Semester 2 • Section 3M',
  ].join('\n');
}

/** Thank-you pools: a teacher who confirms week after week must never read the
 * same acknowledgement twice. One variant is picked at random per answer; all
 * stay brief, professional, and end with the student-visible portal link. */
const FOLLOW_UP_POOLS = {
  yes: [
    ({ teacher, subject, section, day, time }) => [
      `JazakAllah Khair, ${bold(teacher)}! ✅`,
      '',
      `Your ${bold(subject)} lecture on ${day} (${time}) is marked *confirmed* — students of ${bold(section, 25)} have been informed.`,
      '',
      `Portal: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
    ({ teacher, subject, section, day }) => [
      `Thank you for confirming, ${bold(teacher)}! ✅`,
      '',
      `${bold(section, 25)} students can now see your ${bold(subject)} class on ${day} as *confirmed*.`,
      '',
      `View the live class status: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
    ({ teacher, subject, section, day, time }) => [
      `Much appreciated, ${bold(teacher)}! 🌟`,
      '',
      `Your ${bold(subject)} lecture (${day}, ${time}) is confirmed in the portal — ${bold(section, 25)} students have been notified.`,
      '',
      `Tri3M portal: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
    ({ teacher, subject, section, day }) => [
      `Confirmed — thank you, ${bold(teacher)}! ✅`,
      '',
      `Students of ${bold(section, 25)} will see your ${bold(subject)} class as confirmed for ${day}.`,
      '',
      `Check class status anytime: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
  ],
  no: [
    ({ teacher, subject, section, day, time }) => [
      `Thank you for letting us know, ${bold(teacher)}. 🙏`,
      '',
      `Your ${bold(subject)} lecture on ${day} (${time}) is marked *not confirmed* — students of ${bold(section, 25)} have been informed.`,
      '',
      `Portal: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
    ({ teacher, subject, section, day }) => [
      `Received, thank you ${bold(teacher)}. 🙏`,
      '',
      `We have updated your ${bold(subject)} class for ${day} so ${bold(section, 25)} students are not left waiting.`,
      '',
      `View the updated timetable: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
    ({ teacher, subject, section, day, time }) => [
      `Understood, thank you for the quick reply, ${bold(teacher)}. 🙏`,
      '',
      `The ${bold(subject)} class (${day}, ${time}) now shows as *not confirmed* for ${bold(section, 25)} students.`,
      '',
      `Tri3M portal: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
    ({ teacher, subject, section, day }) => [
      `Noted with thanks, ${bold(teacher)}. 🙏`,
      '',
      `Students of ${bold(section, 25)} will see the ${day} ${bold(subject)} class as *not confirmed* — no one is left waiting.`,
      '',
      `Check class status anytime: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
  ],
};

/** Random pick from the pool; exported for tests. kind is 'yes' or 'no'. */
export function buildFollowUpMessage(kind, ctx) {
  const pool = FOLLOW_UP_POOLS[kind === 'yes' ? 'yes' : 'no'];
  const template = pool[Math.floor(Math.random() * pool.length)];
  return template(ctx);
}

/** Queue one request for a newly created or materially changed slot. Missing
 * teacher means no unsolicited messages and a clearly unrequested UI status. */
export async function queueTeacherConfirmation(slot, author) {
  // Backfilled/past classes do not create a pointless WhatsApp request.
  if (new Date(`${slot.date}T${slot.startTime}:00+05:00`).getTime() <= Date.now()) {
    await Timetable.updateOne({ _id: slot._id, status: 'active' }, { $set: { teacherConfirmation: { status: 'none' } } });
    return false;
  }
  const teacher = await Teacher.findOne({ subject: slot.subject, section: slot.section }).lean();
  const phone = teacher?.whatsapp?.replace(/\D/g, '');
  if (!phone) {
    await Timetable.updateOne({ _id: slot._id, status: 'active' }, { $set: { teacherConfirmation: { status: 'none' } } });
    return false;
  }
  const code = randomBytes(5).toString('hex').toUpperCase();
  await Timetable.updateOne({ _id: slot._id, status: 'active' }, { $set: {
    teacherConfirmation: {
      status: 'queued', code, teacher: teacher._id, phone, requestedBy: author?._id, attempts: 0,
      nextAttemptAt: new Date(),
    },
  } });
  // Send inline for single creates/edits; the existing external pinger retries
  // transient failures and handles larger copied batches. No Base44 automation.
  return true;
}

/** Atomic claim avoids a duplicate WhatsApp from concurrent cron + create. */
export async function dispatchTeacherConfirmation(slotId) {
  if (!isConfigured() || !env.whatsapp.webhookSecret) return false;
  const slot = await Timetable.findOneAndUpdate({
    _id: slotId, status: 'active',
    'teacherConfirmation.status': { $in: ['queued', 'failed'] },
    'teacherConfirmation.attempts': { $lt: MAX_ATTEMPTS },
    'teacherConfirmation.nextAttemptAt': { $lte: new Date() },
  }, { $set: { 'teacherConfirmation.status': 'sending', 'teacherConfirmation.claimedAt': new Date() }, $inc: { 'teacherConfirmation.attempts': 1 } }, { new: true }).lean();
  if (!slot) return false;
  const confirmation = slot.teacherConfirmation;
  try {
    // ONE QUESTION AT A TIME per teacher phone. A bare YES/NO carries no
    // class identifier, so two awaiting requests for the same phone would
    // make every plain reply ambiguous (owner rule: the teacher only ever
    // types YES or NO, never a reference code). The earlier claim wins;
    // later requests re-queue and go out the moment the teacher answers.
    // A concurrent sending claim blocks only briefly so a crashed mid-flight
    // send can never jam the queue forever.
    const busy = await Timetable.exists({
      status: 'active', _id: { $ne: slot._id }, 'teacherConfirmation.phone': confirmation.phone,
      $or: [
        { 'teacherConfirmation.status': 'awaiting' },
        { 'teacherConfirmation.status': 'sending', 'teacherConfirmation.claimedAt': { $gt: new Date(Date.now() - 10 * 60_000), $lt: confirmation.claimedAt } },
      ],
    });
    if (busy) {
      await Timetable.updateOne({ _id: slot._id, 'teacherConfirmation.code': confirmation.code, 'teacherConfirmation.status': 'sending' },
        { $set: { 'teacherConfirmation.status': 'queued', 'teacherConfirmation.nextAttemptAt': new Date() },
          $inc: { 'teacherConfirmation.attempts': -1 } }); // waiting behind another class is not a failed attempt
      return false;
    }
    const [section, subject, teacher, author] = await Promise.all([
      Section.findById(slot.section).populate('department', 'name').lean(),
      Subject.findById(slot.subject).lean(),
      Teacher.findById(confirmation.teacher).lean(),
      User.findById(confirmation.requestedBy ?? slot.createdBy).select('name role').lean(),
    ]);
    // Changing/removing the teacher while the slot is pending must not send
    // to a stale number. No silent fallback to an unrelated teacher.
    if (!section || !subject || !teacher || teacher.whatsapp !== confirmation.phone ||
        String(teacher.subject) !== String(slot.subject) || !isConfigured() || !env.whatsapp.webhookSecret) {
      await Timetable.updateOne({ _id: slot._id, 'teacherConfirmation.code': confirmation.code, 'teacherConfirmation.status': 'sending' },
        { $set: { 'teacherConfirmation.status': 'failed', 'teacherConfirmation.attempts': MAX_ATTEMPTS } });
      return false;
    }
    const body = buildTeacherMessage({ section, department: section.department, teacher, subject, author, slot, code: confirmation.code });
    await sendText(confirmation.phone, body);
    await Timetable.updateOne({ _id: slot._id, 'teacherConfirmation.code': confirmation.code, 'teacherConfirmation.status': 'sending' },
      { $set: { 'teacherConfirmation.status': 'awaiting', 'teacherConfirmation.sentAt': new Date() } });
    return true;
  } catch (err) {
    console.error('[teacher confirmation delivery]', err.message);
    await Timetable.updateOne({ _id: slot._id, 'teacherConfirmation.code': confirmation.code, 'teacherConfirmation.status': 'sending' },
      { $set: { 'teacherConfirmation.status': 'failed',
        'teacherConfirmation.nextAttemptAt': new Date(Date.now() + 5 * 60_000 * confirmation.attempts) } });
    return false;
  }
}

/** Existing cron-job.org pinger drains pending/capped retries without creating
 * another job. An old sending claim is not automatically retried, since its
 * gateway result could be unknown and duplicating the teacher message is worse. */
export async function dispatchPendingTeacherConfirmations() {
  if (!isConfigured() || !env.whatsapp.webhookSecret) return { configured: false, processed: 0 };
  const pending = await Timetable.find({
    status: 'active', 'teacherConfirmation.status': { $in: ['queued', 'failed'] },
    'teacherConfirmation.attempts': { $lt: MAX_ATTEMPTS },
    'teacherConfirmation.nextAttemptAt': { $lte: new Date() },
  }).sort({ 'teacherConfirmation.nextAttemptAt': 1 }).limit(BATCH_SIZE).select('_id teacherConfirmation.phone').lean();
  // A bare YES/NO is only unambiguous when the teacher has one open question:
  // dispatch at most one per phone per pass. The queue advances immediately
  // on each teacher answer; the external pinger catches anything left behind.
  const seen = new Set();
  const batch = pending.filter((slot) => {
    const phone = slot.teacherConfirmation?.phone;
    if (!phone || seen.has(phone)) return false;
    seen.add(phone);
    return true;
  });
  const results = await Promise.allSettled(batch.map((slot) => dispatchTeacherConfirmation(slot._id)));
  return { configured: true, processed: results.filter((r) => r.status === 'fulfilled' && r.value).length };
}

/* OWNER UPGRADE (2026-10-07 evening): HUMAN-LIKE teacher conversation.
 * A teacher asking ANY question — CR kaun hai, section/semester kya hai,
 * room/time kya hai — must feel a real, respectful human student is
 * answering. Gemini writes the reply from the REAL awaiting class facts
 * (never invented), answers ONLY what was asked, in the teacher's own
 * language, and gently steers back to YES/NO. Offline fallbacks keep the
 * professional human-worded card/hint. The open question is never
 * answered, consumed or re-queued; strangers stay silent; replays are
 * throttled by questionAnsweredAt (60s). */
const TEACHER_CHAT_TIMEOUT_MS = 8_000;

/* Grounded facts block for the conversation — the ONLY truth the model may use. */
function classStatusLine(status) {
  switch (status) {
    case 'awaiting': return 'awaiting your YES or NO reply';
    case 'confirmed': return 'already CONFIRMED — students already see it as confirmed';
    case 'declined': return 'currently marked NOT confirmed (declined)';
    default: return 'pending — not confirmed yet';
  }
}

function buildTeacherChatFacts({ teacher, section, department, semester, subject, day, time, room, crName, crRole, crPhone, classStatus }) {
  return [
    `Teacher: ${teacher}`,
    `Subject: ${subject}`,
    `Day/Date: ${day}`,
    `Time: ${time}`,
    room ? `Room: ${room}` : 'Room: not recorded',
    `Department: ${department ?? '—'}`,
    `Semester: ${semester ?? '—'}`,
    `Section: ${section ?? '—'}`,
    `The class was scheduled by: ${crName ?? 'the section CR'} (${crRole ?? 'CR'})`,
    crPhone ? `CR's contact number (may be shared with the teacher on request): ${crPhone}` : 'CR contact number: not available',
    `Class status: ${classStatusLine(classStatus)}`,
  ].join('\n');
}

/** One conversational Gemini turn. Returns a human-like reply string, or
 * null when the API is unreachable/invalid (caller falls back to the
 * professional static card). NEVER throws. */
async function chatReplyWithGemini(body, facts, { unclear = false } = {}) {
  const key = env.chatbot?.googleApiKey;
  if (!key) return null;
  if (process.env.NODE_ENV === 'test' && process.env.ALLOW_TEST_GEMINI !== '1') return null;
  try {
    const parsed = await geminiJson({
      systemInstruction: { parts: [{ text: [
        'You are the "Tri3M Class Agent" — an AI chatbot built by the section students, texting your respected teacher on WhatsApp on behalf of the section CR.',
        'Reply in the SAME language the teacher used (Roman Urdu / English / mixed). Short, natural, full of respect — like a polite student texting a respected teacher.',
        'RULES:',
        '1. Answer EVERY question the teacher asks — whatever it is, never a canned dump. Brief (under 60 words). Class details (department, semester, section, subject, date, time, room, CR name/phone) come ONLY from the FACTS below — never invent class details. Small talk or any other question: answer naturally like a person.',
        '2. If the teacher asks WHO or WHAT you are (ap kon ho? / g kon? / kon hai? / who is this?), answer honestly and simply: you are the Tri3M Class Agent — an AI chatbot made by the section students — texting on behalf of the CR named in the FACTS, to remind them about the class and get a YES/NO; then kindly ask for the YES/NO. Example: "Sir, main Tri3M ka AI chatbot hun — aap ke section CR ke taraf se reminder bheja hai ke aap ki class hai. Kindly YES ya NO bata dein." (in their language, short).',
        '3. Without being asked, never start robot talk (AI/bot/team/offline/support). But when asked who you are, the honest AI-chatbot intro above IS the answer — never hide it.',
        '4. The FACTS include the current Class status — state it truthfully ONLY if relevant (already confirmed / awaiting their YES/NO). Never claim you marked anything; their YES/NO reply does that.',
        unclear
          ? '5. The teacher\'s message could not be understood as an answer about attending the class: very politely say you could not follow it, and request a plain YES (you will take the class) or NO (you cannot) so the students see the correct status.'
          : '5. Only when the Class status says it is awaiting your YES or NO, end with ONE short natural line asking them to reply YES or NO whenever convenient — if already confirmed or declined, never re-ask; just answer what they asked.',
      ].join('\n') + '\n\nFACTS:\n' + facts }] },
      contents: [{ role: 'user', parts: [{ text: String(body).slice(0, 300) }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 300, responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { reply: { type: 'STRING' } }, required: ['reply'] } },
    }, TEACHER_CHAT_TIMEOUT_MS);
    const reply = String(parsed?.reply ?? '').trim();
    return reply ? reply.slice(0, 800) : null;
  } catch { return null; }
}

/** Claim the open awaiting question and answer the teacher like a human:
 * Gemini conversation first, static professional fallback when offline.
 * mode: 'question' (teacher asked something) | 'unclear' (could not follow). */
async function converseWithTeacher(sender, payload, mode) {
  const rawTime = Number(payload.data.time ?? payload.data.timestamp);
  const epoch = rawTime > 1e11 ? rawTime / 1000 : rawTime;
  if (!Number.isFinite(epoch) || epoch < 1_500_000_000 || epoch > Date.now() / 1000 + 300) return false;
  const replyTime = new Date(epoch * 1000);
  let slot = await Timetable.findOneAndUpdate({
    status: 'active',
    'teacherConfirmation.phone': sender,
    'teacherConfirmation.status': 'awaiting',
    'teacherConfirmation.sentAt': { $lte: new Date(replyTime.getTime() + 10_000) },
    $or: [{ 'teacherConfirmation.questionAnsweredAt': null }, { 'teacherConfirmation.questionAnsweredAt': { $lt: new Date(Date.now() - QUESTION_COOLDOWN_MS) } }],
  }, { $set: { 'teacherConfirmation.questionAnsweredAt': new Date() } })
    .select('section subject date startTime endTime room createdBy teacherConfirmation').lean();
  // OWNER BUG FIX (2026-10-07 night): the teacher may ask 'g kon?' in reply to
  // the 20-min PRE-CLASS REMINDER, not to a confirmation question — the class
  // can already be confirmed/declined (no awaiting slot). A teacher asking
  // who is texting must NEVER get silence: answer from their REAL class
  // today (facts only, status told truthfully, question never re-asked).
  if (!slot) {
    const karachiDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
    const days = [0, 1].map((offset) => karachiDay.format(new Date(Date.now() + offset * 86_400_000))); // today + tomorrow PKT
    slot = await Timetable.findOneAndUpdate({
      status: 'active',
      'teacherConfirmation.phone': sender,
      'teacherConfirmation.status': { $in: ['confirmed', 'declined', 'queued', 'sending', 'failed'] },
      date: { $in: days },
      $or: [{ 'teacherConfirmation.questionAnsweredAt': null }, { 'teacherConfirmation.questionAnsweredAt': { $lt: new Date(Date.now() - QUESTION_COOLDOWN_MS) } }],
    }, { $set: { 'teacherConfirmation.questionAnsweredAt': new Date() } })
      .sort({ startTime: 1 })
      .select('section subject date startTime endTime room createdBy teacherConfirmation').lean();
  }
  if (!slot) return false; // nothing real to answer from — silence, never invent
  try {
    const [sectionDoc, subjectDoc, teacherDoc, crDoc] = await Promise.all([
      Section.findById(slot.section).populate('department', 'name').select('name semester department').lean(),
      Subject.findById(slot.subject).select('name').lean(),
      Teacher.findById(slot.teacherConfirmation?.teacher).select('name').lean(),
      // the CR/GR who actually queued this class (requestedBy), falling back
      // to the class creator — the conversation names a REAL person
      User.findById(slot.teacherConfirmation?.requestedBy ?? slot.createdBy).select('name role phone').lean(),
    ]);
    if (!teacherDoc) return true; // claimed, but nothing true to say — never invent
    const ctx = {
      teacher: teacherDoc.name,
      section: sectionDoc?.name,
      department: sectionDoc?.department?.name,
      semester: sectionDoc?.semester,
      subject: subjectDoc?.name,
      day: fmtDate.format(new Date(`${slot.date}T12:00:00+05:00`)),
      time: `${fmtTime(slot.startTime)} – ${fmtTime(slot.endTime)}`,
      room: slot.room,
      crName: crDoc?.name,
      crRole: crDoc?.role === 'gr' ? 'GR' : crDoc?.role === 'admin' ? 'Admin' : 'CR',
      crPhone: crDoc?.phone ? String(crDoc.phone).replace(/[^\d+]/g, '') : null,
      classStatus: slot.teacherConfirmation?.status ?? null,
    };
    // HUMAN conversation first; offline → professional static fallbacks
    const reply = await chatReplyWithGemini(String(payload.data.body ?? ''), buildTeacherChatFacts(ctx), { unclear: mode === 'unclear' });
    const message = reply ?? (mode === 'unclear'
      ? buildHintMessage(teacherDoc.name)
      : INTERPRET_IDENTITY_RE.test(String(payload.data.body ?? ''))
        ? buildIdentityMessage(ctx)
        : buildQuestionAnswerMessage(ctx));
    await sendText(sender, message);
  } catch (err) { console.error('[teacher conversation]', err.message); } // best-effort
  return true;
}

/* ------------------------------------------------------------------ */
/* OWNER FEATURE (2026-10-07): teachers may ASK questions. Facts and     */
/* cooldown for the conversational engine above; the static card below   */
/* is the OFFLINE fallback when Gemini is unreachable. The open YES/NO   */
/* question stays fully intact: answering costs no attempt, consumes    */
/* no queue slot. Strangers/group numbers stay silent.                   */
/* ------------------------------------------------------------------ */
const QUESTION_COOLDOWN_MS = 60 * 1000;

/* OWNER FEATURE (2026-10-07 night): when EVERY Gemini model is down, a
 * teacher asking "ap kon ho? / g kon?" must still get a SHORT honest intro —
 * NOT the full details card. The card is only for detail questions. */
/* sender-identity ONLY (ap/g/tum kon?, who is this?) — NOT detail questions
 * like 'CR kaun hai?' (asks the CR's name → full card). */
const INTERPRET_IDENTITY_RE = /\b(ap|aap|tum|tu|g|ji|gee)\s+(kon|kaun|kvn)\b|^\s*(kon|kaun|kvn)\b|\b(kon|kaun|kvn)\s*\?+\s*$|\bwho\b\s*(?:is|are)?\s*(?:this|that|you|u|messaging|texting)?\b\s*(?:me|u|you)?\s*\?*\s*$/i;

export function buildIdentityMessage({ teacher, section, subject, day, time, room, crName, crRole, crPhone }) {
  const lines = [
    `Assalam-o-Alaikum Respected ${bold(teacher)},`,
    '',
    `I am the ${bold('Tri3M Class Agent')} — an AI chatbot built by the students of your section, texting on behalf of ${bold(crName ?? 'your section CR')} (${crRole ?? 'CR'} of ${bold(section, 25)}).`,
  ];
  if (crPhone) lines.push(`You may also contact ${crName ?? 'the CR'} directly: ${crPhone}`);
  lines.push(
    `I sent you the reminder because your ${bold(subject)} class is scheduled for ${bold(day)} at ${bold(time)}${room ? `, ${bold(room, 40)}` : ''}.`,
    '',
    'Kindly reply:',
    '*YES* — you will take the class',
    '*NO* — you cannot take the class',
    '',
    'Thank you for your cooperation.',
    'JazakAllah Khair.',
  );
  return lines.join('\n');
}

/** Full details card — answers every basic question at once: department,
 * semester, section, subject, date, time, room, and the CR's name + phone
 * so the teacher can even CALL the CR. Ends with the pending YES/NO ask.
 * Exported for tests. */
export function buildQuestionAnswerMessage({ teacher, section, department, semester, subject, day, time, room, crName, crRole, crPhone, classStatus }) {
  const lines = [
    '*Tri3M Class Agent*',
    'AI-Powered Class Management Assistant',
    '',
    `Assalam-o-Alaikum Respected ${bold(teacher)},`,
    '',
    'Of course! Here are the complete details of your scheduled class:',
    '',
    `🎓 Department: ${bold(department ?? '—')}`,
    `📚 Semester: ${bold(String(semester ?? '—'))}`,
    `🏫 Section: ${bold(section, 25)}`,
    `📖 Subject: ${bold(subject)}`,
    `📅 Date: ${bold(day)}`,
    `🕐 Time: ${bold(time)}`,
  ];
  if (room) lines.push(`📍 Room: ${bold(room, 40)}`);
  if (crName) {
    lines.push('', `👤 This class was scheduled with you by ${bold(crName)} (${crRole ?? 'CR'} of ${bold(section, 25)}).`);
    if (crPhone) lines.push(`📞 You may contact them directly: ${crPhone}`);
  }
  lines.push('');
  if (classStatus === 'confirmed') {
    lines.push(`Your class status is already *CONFIRMED* — no reply needed. Your students of ${bold(section, 25)} are informed.`);
  } else if (classStatus === 'declined') {
    lines.push('Your class is currently marked *NOT confirmed* for your students.', 'If that has changed, please reply *YES* or *NO*.');
  } else {
    lines.push(
      'To update the class status for your students, please reply:',
      '*YES* — you will take the class',
      '*NO* — you cannot take the class');
  }
  lines.push(
    '',
    'Thank you for your cooperation.',
    'JazakAllah Khair.',
    '',
    '— Tri3M Class Agent',
    'Developed by the students of the AI Department, IUB',
    'Semester 2 • Section 3M',
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* OWNER FEATURE (2026-10-04): natural-language teacher replies.        */
/* Teachers type real sentences — "g beta kl class ho gi time pe" —      */
/* instead of a bare YES/NO, and the only-YES-or-NO reminder irritated   */
/* them. Now EVERY reply is interpreted: fast local rules decide first   */
/* (no API cost, deterministic); only a genuinely unclear reply goes    */
/* to Gemini for classification. An interpreted answer updates the      */
/* class status exactly like a plain YES/NO and the teacher receives   */
/* an ENGLISH acknowledgement that states what was understood.          */
/* ------------------------------------------------------------------ */

const INTERPRET_TIMEOUT_MS = 5_000;

/* Order matters: "abhi pata nahi" is NOT a NO (unclear first); "no problem"
 * is a YES; any negation wins over affirmation ("haan nahi ho gi" = NO). */
const INTERPRET_UNCLEAR_RE = /pata nahi|pata nh\b|abhi (nahi|nh)\b|maybe|shayad|dekh(te|ta|ta hai| ke|kar)|soch( kar| ke)|baad (me|men) bata|let you know|i'?ll confirm later|wait|inta ?zar|thori der/i;
const INTERPRET_NOPROBLEM_RE = /no problem|no issue|no worries|koi (masla|baat) nahi/i;
const INTERPRET_NO_RE = /\b(nahi|nahin|nay?hi|nhi|nyi|nai|ni|ny|nhn|nh|no|nahi\?)\b|cancel|postpone|can'?t|cannot|not possible|impossible|busy ho|urgent|emergency|khali nahi|chutti|strike|ho (nahi|nhi|ni) (ga|gi)|mera dil (nahi|ni|nhi)|mood (nahi|ni|nhi)/i;
// YES words stay SOLID — weak words are deliberately excluded: bare 'ha'
// is usually just 'hai' (mera dil NI HA = NO), 'ya' means 'or'. If a reply
// matches none of these the rules return UNCLEAR and Gemini judges it.
const INTERPRET_YES_RE = /(ho|how) ?g[iay]a?|\b(g|gee|ji|haan|han|haa|hmm+|yes|yep|ok|okay|okie|sure|bilkul|zaroor|pakka|insha? ?allah|inshallah|definitely|confirmed?|ready|aaon|aaon ga|aaunga|aaonga|aa raha|aa rahi|time ?pe?|on time|theek hai|chal[ie]gi|chal[ie]ga)\b/i;

/* OWNER BUG FIX (2026-10-07 night): strong, UNMISTAKABLE yes words. 'g'/'gee'/
 * 'ji'/'hmm' are polite particles — on their own, especially next to a
 * question ('g kon?'), they are NOT agreement. Used to guard a Gemini
 * YES/NO verdict on a question-looking reply (see interpretTeacherReply). */
const INTERPRET_STRONG_YES_RE = /(ho|how) ?g[iay]a?|\b(haan|han|haa|yes|yep|ok|okay|okie|sure|bilkul|zaroor|pakka|insha ?llah|inshallah|definitely|confirmed|ready|theek hai|aaon|aaon ga|aaunga|aaonga|aa raha|aa rahi|time ?pe|on time|ho ga|ho gi|ho gya|ho gaya|ho gayi|chal[ie]ga|chal[ie]gi)\b/i;

/* OWNER FEATURE (2026-10-07): a teacher asking a BASIC question — which
 * section / department / semester, who is the CR, which room/time — gets a
 * professional full-details answer card, never the dry only-YES-or-NO hint.
 * Offline safety net (Gemini is the primary judge); kept broad enough for
 * Roman Urdu + English. OWNER BUG FIX (2026-10-07 night): a teacher replied
 * 'g kon?' (who is this?) to the pre-class reminder and the class got
 * CONFIRMED — 'g' (polite ji) matched the YES list and a bare kon/kaun/who
 * was not a question, so identity questions now ALWAYS outrank yes/no.
 * 'samajh nahi aa raha' is confusion → QUESTION too
 * (it used to fall through to the NO word-list — wrong answer to a teacher
 * who simply did not understand the message). */
const INTERPRET_QUESTION_RE = /which (section|class|semester|department|dept|subject|room|cr|time)|what (section|class|semester|department|dept|subject|room|time|is this|is that|about)|who (is|are|this|that)\b|who are you|\bwho\b|\b(kon|kaun|kvn)\b|\b(aap|ap|ye|yeh|tum|tu) (kon|kaun|kvn)\b|\bkab\b|\bkahan\b|kons?[aiy]? (section|class|subject|semester|sem|dept|department|room|group|time|class)|kaun sa (section|class|subject|room|semester)|kaun si (class|section)|section (kon|kaun|kya|which|konsa|konsi)|semester (kon|kaun|kya|which|konsa|konsi)|department (kon|kaun|kya|which|konsa)|dept (kon|kaun|kya|which)|cr (kon|kaun|kya|who|kaun hai|kon hai|number|num)|room (kya|kon|kaun|which|kahan|kaha|number)|kab (hai|ho|lgi|legi|leni|lagna)|kahan (hai|ho|class)|samajh (nahi|nh|ni|nahin|nai)|smajh (nahi|nh|ni|nahin)|samjh (nahi|nh|ni)/i;

/** Local rules: 'YES' | 'NO' | 'QUESTION' | null (unclear → try Gemini). Exported for tests. */
export function interpretReply(body) {
  const t = String(body ?? '').toLowerCase().trim();
  if (!t || t.length > 300) return null;
  if (INTERPRET_UNCLEAR_RE.test(t)) return null;
  if (INTERPRET_NOPROBLEM_RE.test(t)) return 'YES';
  // a basic question outranks stray yes/no words ('konsa section hai' contains
  // 'hai', 'section hai nahi ho gi' would read as NO — a question is a question)
  if (INTERPRET_QUESTION_RE.test(t)) return 'QUESTION';
  if (INTERPRET_NO_RE.test(t)) return 'NO';
  if (INTERPRET_YES_RE.test(t)) return 'YES';
  return null;
}

/* OWNER FIX (2026-10-07 night, LIVE incident): gemini-flash-latest was serving
 * 503 "high demand" in production, so EVERY teacher conversation silently
 * fell back to the static word-list card — the owner read it as "still word-
 * trained". Same cure as the group chatbot: try the primary model, then the
 * backup models, until one answers. */
const GEMINI_MODELS = (process.env.CHATBOT_GEMINI_BACKUP || 'gemini-flash-latest,gemini-3.1-flash-lite')
  .split(',').map((m) => m.trim()).filter(Boolean);

/** POST generateContent to each model in turn; returns the parsed JSON object
 * or null when every model is down/unparseable. NEVER throws. */
async function geminiJson(payload, timeoutMs) {
  const key = env.chatbot?.googleApiKey ?? '';
  for (const model of GEMINI_MODELS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) continue; // 503 / 404 / overload → next model
      const json = await res.json();
      const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      try { return JSON.parse(raw) ?? null; } catch { continue; }
    } catch { continue; } // timeout / network → next model
    finally { clearTimeout(timer); }
  }
  return null;
}

/** Gemini classifier: returns 'YES' | 'NO' | 'QUESTION' | 'UNCLEAR', or null when the API
 * is unreachable (no key, network, timeout, bad response). NEVER throws. */
async function classifyReplyWithGemini(body) {
  const key = env.chatbot?.googleApiKey;
  if (!key) return null;
  // tests stay deterministic: Gemini is opt-in via ALLOW_TEST_GEMINI=1 and a
  // mocked generativelanguage fetch — production always calls the real API.
  if (process.env.NODE_ENV === 'test' && process.env.ALLOW_TEST_GEMINI !== '1') return null;
  try {
    const parsed = await geminiJson({
      systemInstruction: { parts: [{ text: 'A teacher was asked "Please reply YES or NO" about taking a scheduled class. The teacher replied in ANY style — English, Urdu, Roman Urdu, mixed, polite, indirect, or expressing feelings (e.g. "mera dil nahi hai" = NO, "inshallah aaon ga" = YES, "mood nahi" = NO). Read the MEANING, not exact words. YES = the teacher will take the class / will come. NO = the teacher will not take it / cannot come / does not want to. QUESTION = the teacher is asking for information about the class — which section / department / semester / subject / room / time / date, who the CR is (name or phone), who or what this assistant is, or expressing confusion about WHICH class this is (e.g. "which section is this?", "kaun sa semester hai?", "mujhe samajh nahi aa raha ye konsi class hai", "who is messaging me?"). If the teacher CLEARLY states they will or will not take the class, that verdict wins even if they also ask a question. UNCLEAR = genuinely cannot decide what they mean about attending (maybe, I will tell you later, unrelated chatter). Return ONLY JSON {"answer":"YES"|"NO"|"QUESTION"|"UNCLEAR"}.' }] },
      contents: [{ role: 'user', parts: [{ text: String(body).slice(0, 300) }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 60, responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { answer: { type: 'STRING', enum: ['YES', 'NO', 'QUESTION', 'UNCLEAR'] } }, required: ['answer'] } },
    }, INTERPRET_TIMEOUT_MS);
    if (!parsed) return null; // every model unreachable → local rules safety net
    const ans = String(parsed?.answer ?? '').toUpperCase();
    return ans === 'YES' || ans === 'NO' || ans === 'QUESTION' ? ans : 'UNCLEAR';
  } catch { return null; }
}

/** Interpret ANY teacher reply into 'YES' | 'NO' | 'QUESTION' | null.
 * OWNER RULE (2026-10-04): the teacher can type ANYTHING — Roman Urdu, Urdu,
 * English, mixed, feelings ('mera dil nahi hai') — so the LLM judges every
 * natural reply FIRST for real understanding, not a fixed word list. The
 * local rules only act as a safety net when Gemini is unavailable, and the
 * polite hint fires only when BOTH say the reply is unclear. OWNER RULE
 * (2026-10-07): a QUESTION (which section/dept/semester, who is the CR,
 * room/time confusion) routes to the full-details answer card instead. */
export async function interpretTeacherReply(body) {
  const viaGemini = await classifyReplyWithGemini(body);
  if (viaGemini === 'YES' || viaGemini === 'NO') {
    // OWNER BUG FIX (2026-10-07 night): a question-looking reply with NO strong
    // yes/no word can NEVER confirm/deny a class ('g kon?' was confirmed YES).
    // It becomes a QUESTION and gets a human conversational answer instead.
    const t = String(body ?? '').toLowerCase().trim();
    if (INTERPRET_QUESTION_RE.test(t) || t.endsWith('?')) {
      if (viaGemini === 'YES' && !INTERPRET_STRONG_YES_RE.test(t)) return 'QUESTION';
      if (viaGemini === 'NO' && !INTERPRET_NO_RE.test(t)) return 'QUESTION';
    }
    return viaGemini;
  }
  if (viaGemini === 'QUESTION') return 'QUESTION';
  // The LLM REACHED a verdict of UNCLEAR — its reading is final, the greedy
  // word rules must not second-guess it ("samajh nahi aa raha" is not a NO).
  if (viaGemini === 'UNCLEAR') return null;
  // API unreachable → local rules as the safety net
  return interpretReply(body);
}

/* Interpreted-answer acknowledgements (ENGLISH, owner rule 2026-10-04): the
 * teacher must see WHAT was understood — "your reply was understood as a
 * YES/NO" — plus the updated class status. Rotating variants, never identical. */
const INTERPRETED_ACK_POOLS = {
  yes: [
    ({ teacher, subject, section, day, time }) => [
      `Thank you, ${bold(teacher)}! I understood your reply as a *YES*. ✅`,
      '',
      `Your ${bold(subject)} lecture on ${day} (${time}) is marked *confirmed* — students of ${bold(section, 25)} have been informed.`,
      '',
      `Portal: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
    ({ teacher, subject, section, day, time }) => [
      `Got it, ${bold(teacher)} — thank you! Your reply reads as a confirmation. ✅`,
      '',
      `${bold(subject)} (${day}, ${time}) is now *confirmed* on the portal for ${bold(section, 25)}.`,
      '',
      `Portal: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
  ],
  no: [
    ({ teacher, subject, section, day, time }) => [
      `Thank you for letting us know, ${bold(teacher)}. I understood your reply as a *NO*.`,
      '',
      `Your ${bold(subject)} lecture on ${day} (${time}) is marked *cancelled* — students of ${bold(section, 25)} have been informed.`,
      '',
      `Portal: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
    ({ teacher, subject, section, day, time }) => [
      `Understood, ${bold(teacher)} — thank you for the update. Your reply reads as a cancellation.`,
      '',
      `${bold(subject)} (${day}, ${time}) is now *cancelled* on the portal for ${bold(section, 25)}.`,
      '',
      `Portal: ${PORTAL_URL}`,
      '',
      '— Tri3M Class Agent',
    ].join('\n'),
  ],
};

/** Acknowledge an INTERPRETED answer so the teacher sees what was understood. */
export function buildInterpretedAckMessage(kind, ctx) {
  const pool = INTERPRETED_ACK_POOLS[kind === 'yes' ? 'yes' : 'no'];
  return pool[Math.floor(Math.random() * pool.length)](ctx);
}

/** UltraMsg official webhook payload: {event_type,instanceId,data:{id,from,
 * type,body,fromMe}}. Caller authenticates the webhook with an independent
 * URL secret. Exact references select a slot; plain YES/NO requires one
 * pending slot and a message timestamp after its send. Duplicate/replayed/
 * late replies are no-ops. A NATURAL-LANGUAGE reply ("g beta class ho gi")
 * is interpreted first (rules, then Gemini) and handled like a YES/NO with
 * an English acknowledgement; a genuinely unclear reply still gets the
 * polite only-YES-or-NO reminder. */
export async function handleTeacherReply(payload) {
  if (payload?.event_type !== 'message_received' ||
      String(payload?.instanceId ?? '').replace(/^instance/i, '') !==
        String(env.whatsapp.instanceId ?? '').replace(/^instance/i, '') ||
      payload?.data?.fromMe !== false || payload?.data?.type !== 'chat') return false;
  const body = String(payload.data.body ?? '').trim();
  const exact = /^(YES|NO)\s+([A-F0-9]{10})\s*[.!]?$/i.exec(body);
  const plain = /^(YES|NO)\s*[.!]?$/i.exec(body);
  const sender = String(payload.data.from ?? '').split('@')[0].replace(/\D/g, '');
  if (!sender || !payload.data.id) return false;
  // OWNER FEATURE: a natural-language reply is INTERPRETED first. Only a
  // genuinely unclear reply falls back to the polite YES-or-NO reminder.
  let interpreted = null; // 'YES' | 'NO' | 'QUESTION' | null
  if (!exact && !plain) {
    interpreted = await interpretTeacherReply(body);
    // OWNER FEATURE (2026-10-07): a teacher asking a basic question gets a
    // HUMAN conversational answer; a genuinely unclear reply politely asks
    // for YES/NO — like a real person, never robot talk.
    if (interpreted === 'QUESTION') return converseWithTeacher(sender, payload, 'question');
    if (!interpreted) return converseWithTeacher(sender, payload, 'unclear');
  }
  const answer = exact ? exact[1].toUpperCase() : plain ? plain[1].toUpperCase() : interpreted;
  let slot;
  if (exact) {
    slot = await Timetable.findOne({ status: 'active', 'teacherConfirmation.code': exact[2].toUpperCase(),
      'teacherConfirmation.phone': sender }).select('section subject date startTime endTime teacherConfirmation').lean();
  } else {
    // A bare YES/NO has no class identifier: accept it ONLY when the teacher
    // has exactly one awaiting request. The provider message time also must
    // postdate that request; old/replayed answers must not confirm a new slot.
    const rawTime = Number(payload.data.time ?? payload.data.timestamp);
    const epoch = rawTime > 1e11 ? rawTime / 1000 : rawTime; // seconds in webhook, millis in some chat histories
    if (!Number.isFinite(epoch) || epoch < 1_500_000_000 || epoch > Date.now() / 1000 + 300) return false;
    const replyTime = new Date(epoch * 1000);
    const matches = await Timetable.find({ status: 'active', 'teacherConfirmation.phone': sender,
      'teacherConfirmation.status': 'awaiting',
      'teacherConfirmation.sentAt': { $lte: new Date(replyTime.getTime() + 10_000) },
    }).limit(2).select('section subject date startTime endTime teacherConfirmation').lean();
    if (matches.length !== 1 || !matches[0].teacherConfirmation.sentAt ||
        new Date(matches[0].teacherConfirmation.sentAt).getTime() > replyTime.getTime() + 10_000) return false;
    slot = matches[0];
  }
  if (!slot?.teacherConfirmation?.teacher) return false;
  const linked = await Teacher.exists({ _id: slot.teacherConfirmation.teacher,
    section: slot.section, subject: slot.subject, whatsapp: sender });
  if (!linked) return false;
  const updated = await Timetable.findOneAndUpdate({
    _id: slot._id, status: 'active', 'teacherConfirmation.code': slot.teacherConfirmation.code,
    'teacherConfirmation.phone': sender,
    'teacherConfirmation.status': exact ? { $in: ['sending', 'awaiting', 'failed'] } : 'awaiting',
  }, { $set: {
    'teacherConfirmation.status': answer === 'YES' ? 'confirmed' : 'declined',
    'teacherConfirmation.respondedAt': new Date(),
    'teacherConfirmation.replyId': String(payload.data.id).slice(0, 200),
  } }, { new: true }).select('_id').lean();
  if (updated) {
    // Thank the teacher with a randomly rotated variant (never the same
    // acknowledgement twice) and hand them the student-visible portal link.
    // Best-effort: a gateway hiccup never blocks the next class question.
    try {
      const [sectionDoc, subjectDoc, teacherDoc] = await Promise.all([
        Section.findById(slot.section).populate('department', 'name').select('name semester department').lean(),
        Subject.findById(slot.subject).select('name').lean(),
        Teacher.findById(slot.teacherConfirmation.teacher).select('name').lean(),
      ]);
      if (teacherDoc) {
        // an INTERPRETED answer gets the English "here is what I understood"
        // acknowledgement; a plain YES/NO keeps the usual thank-you pool
        const message = interpreted
          ? buildInterpretedAckMessage(answer === 'YES' ? 'yes' : 'no', {
            teacher: teacherDoc.name,
            subject: subjectDoc?.name,
            section: sectionDoc?.name,
            day: fmtDate.format(new Date(`${slot.date}T12:00:00+05:00`)),
            time: `${fmtTime(slot.startTime)} – ${fmtTime(slot.endTime)}`,
          })
          : buildFollowUpMessage(answer === 'YES' ? 'yes' : 'no', {
            teacher: teacherDoc.name,
            subject: subjectDoc?.name,
            section: sectionDoc?.name,
            day: fmtDate.format(new Date(`${slot.date}T12:00:00+05:00`)),
            time: `${fmtTime(slot.startTime)} – ${fmtTime(slot.endTime)}`,
          });
        await sendText(sender, message);
      }
    } catch (err) { console.error('[teacher follow-up]', err.message); }
    // The answer frees the queue: ask the teacher's next pending class now,
    // so the conversation stays one simple YES/NO question at a time.
    try {
      const next = await Timetable.findOne({ status: 'active', 'teacherConfirmation.phone': sender,
        'teacherConfirmation.status': { $in: ['queued', 'failed'] },
        'teacherConfirmation.attempts': { $lt: MAX_ATTEMPTS },
      }).sort({ 'teacherConfirmation.nextAttemptAt': 1 }).select('_id').lean();
      if (next) await dispatchTeacherConfirmation(next._id);
    } catch { /* best-effort: the external pinger retries anything missed */ }
  }
  return Boolean(updated);
}

/** Side-channel safety: a gateway/lookup failure cannot turn a successfully
 * saved timetable slot into an API error or interrupt the existing group flow. */
export async function requestTeacherConfirmation(slot, author) {
  try {
    if (await queueTeacherConfirmation(slot, author)) await dispatchTeacherConfirmation(slot._id);
  } catch (err) {
    console.error('[teacher confirmation request]', err.message);
  }
}
