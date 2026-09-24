import { randomBytes } from 'node:crypto';
import { Section, Subject, Teacher, Timetable, User } from '../models/index.js';
import { env } from '../config/env.js';
import { isConfigured, sendText } from './whatsappService.js';

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 3; // existing external 5-minute pinger, no new jobs or Base44 usage
const fmtDate = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Karachi' });
const clean = (value, max = 65) => String(value ?? '').replace(/[\r\n\t*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const bold = (value, max = 65) => `*${clean(value, max)}*`;
const PORTAL_URL = process.env.APP_URL || 'https://iubcr.vercel.app';

/** PKT-relative label so the greeting line never lies about the day. */
const relativeDay = (dateStr) => {
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const diff = Math.round((new Date(`${dateStr}T12:00:00Z`).getTime() - new Date(`${todayStr}T12:00:00Z`).getTime()) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
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
    `Your ${bold(subject.name)} lecture is scheduled for ${relativeDay(slot.date)}:`,
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

/** UltraMsg official webhook payload: {event_type,instanceId,data:{id,from,
 * type,body,fromMe}}. Caller authenticates the webhook with an independent
 * URL secret. Exact references select a slot; plain YES/NO requires one
 * pending slot and a message timestamp after its send. Duplicate/replayed/
 * late replies are no-ops. */
export async function handleTeacherReply(payload) {
  if (payload?.event_type !== 'message_received' ||
      String(payload?.instanceId ?? '').replace(/^instance/i, '') !==
        String(env.whatsapp.instanceId ?? '').replace(/^instance/i, '') ||
      payload?.data?.fromMe !== false || payload?.data?.type !== 'chat') return false;
  const body = String(payload.data.body ?? '').trim();
  const exact = /^(YES|NO)\s+([A-F0-9]{10})\s*[.!]?$/i.exec(body);
  const plain = /^(YES|NO)\s*[.!]?$/i.exec(body);
  if (!exact && !plain) return false;
  const sender = String(payload.data.from ?? '').split('@')[0].replace(/\D/g, '');
  if (!sender || !payload.data.id) return false;
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
    'teacherConfirmation.status': (exact || plain)[1].toUpperCase() === 'YES' ? 'confirmed' : 'declined',
    'teacherConfirmation.respondedAt': new Date(),
    'teacherConfirmation.replyId': String(payload.data.id).slice(0, 200),
  } }, { new: true }).select('_id').lean();
  if (updated) {
    // Thank the teacher with a randomly rotated variant (never the same
    // acknowledgement twice) and hand them the student-visible portal link.
    // Best-effort: a gateway hiccup never blocks the next class question.
    try {
      const answer = (exact || plain)[1].toUpperCase();
      const [sectionDoc, subjectDoc, teacherDoc] = await Promise.all([
        Section.findById(slot.section).populate('department', 'name').select('name semester department').lean(),
        Subject.findById(slot.subject).select('name').lean(),
        Teacher.findById(slot.teacherConfirmation.teacher).select('name').lean(),
      ]);
      if (teacherDoc) {
        await sendText(sender, buildFollowUpMessage(answer === 'YES' ? 'yes' : 'no', {
          teacher: teacherDoc.name,
          subject: subjectDoc?.name,
          section: sectionDoc?.name,
          day: fmtDate.format(new Date(`${slot.date}T12:00:00+05:00`)),
          time: `${fmtTime(slot.startTime)} – ${fmtTime(slot.endTime)}`,
        }));
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
