import { randomBytes } from 'node:crypto';
import { Section, Subject, Teacher, Timetable, User } from '../models/index.js';
import { env } from '../config/env.js';
import { isConfigured, sendText } from './whatsappService.js';

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 3; // existing external 5-minute pinger, no new jobs or Base44 usage
const fmtDate = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Karachi' });
const clean = (value, max = 65) => String(value ?? '').replace(/[\r\n\t*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const fmtTime = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
};

/** A short per-revision reference is mandatory: plain YES is ambiguous when
 * one teacher has multiple classes, and a delayed duplicate could confirm
 * the wrong slot. The private sender number must also match the linked teacher. */
export function buildTeacherMessage({ section, department, teacher, subject, author, slot, code }) {
  const day = fmtDate.format(new Date(`${slot.date}T12:00:00+05:00`));
  const authorRole = author?.role === 'gr' ? 'GR' : author?.role === 'cr' ? 'CR' : 'Admin';
  return [
    `*${clean(department?.name)} · Semester ${section.semester} · Section ${clean(section.name, 25)}*`,
    `Hello ${clean(teacher.name)}, your *${clean(subject.name)}* class is scheduled for *${day}, ${fmtTime(slot.startTime)}–${fmtTime(slot.endTime)}*. Added by ${clean(author?.name)} (${authorRole}).`,
    `Will you take this class? Reply *YES ${code}* or *NO ${code}*.`,
    '',
    '_Tri3M Class Agent · Your reply updates the student timetable. Developed by the students of AI Dept, Semester 2, Section 3M._',
  ].join('\n');
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
  }, { $set: { 'teacherConfirmation.status': 'sending' }, $inc: { 'teacherConfirmation.attempts': 1 } }, { new: true }).lean();
  if (!slot) return false;
  const confirmation = slot.teacherConfirmation;
  try {
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
  }).sort({ 'teacherConfirmation.nextAttemptAt': 1 }).limit(BATCH_SIZE).select('_id').lean();
  const results = await Promise.allSettled(pending.map((slot) => dispatchTeacherConfirmation(slot._id)));
  return { configured: true, processed: results.filter((r) => r.status === 'fulfilled' && r.value).length };
}

/** UltraMsg official webhook payload: {event_type,instanceId,data:{id,from,
 * type,body,fromMe}}. Caller authenticates the webhook with an independent
 * URL secret. Only an exact answer + reference + matching teacher number can
 * change an ACTIVE slot. Duplicate/replayed/late replies are no-ops. */
export async function handleTeacherReply(payload) {
  if (payload?.event_type !== 'message_received' ||
      String(payload?.instanceId ?? '').replace(/^instance/i, '') !==
        String(env.whatsapp.instanceId ?? '').replace(/^instance/i, '') ||
      payload?.data?.fromMe !== false || payload?.data?.type !== 'chat') return false;
  const match = /^\s*(YES|NO)\s+([A-F0-9]{10})\s*[.!]?\s*$/i.exec(String(payload.data.body ?? ''));
  if (!match) return false;
  const sender = String(payload.data.from ?? '').split('@')[0].replace(/\D/g, '');
  if (!sender || !payload.data.id) return false;
  // A teacher who was unlinked or whose number changed must not be able to
  // approve a class from an obsolete request, even if their old phone and
  // private reference still match the WhatsApp message.
  const slot = await Timetable.findOne({ status: 'active', 'teacherConfirmation.code': match[2].toUpperCase(),
    'teacherConfirmation.phone': sender }).select('section subject teacherConfirmation.teacher').lean();
  if (!slot?.teacherConfirmation?.teacher) return false;
  const linked = await Teacher.exists({ _id: slot.teacherConfirmation.teacher,
    section: slot.section, subject: slot.subject, whatsapp: sender });
  if (!linked) return false;
  const updated = await Timetable.findOneAndUpdate({
    status: 'active', 'teacherConfirmation.code': match[2].toUpperCase(),
    'teacherConfirmation.phone': sender,
    'teacherConfirmation.status': { $in: ['sending', 'awaiting', 'failed'] },
  }, { $set: {
    'teacherConfirmation.status': match[1].toUpperCase() === 'YES' ? 'confirmed' : 'declined',
    'teacherConfirmation.respondedAt': new Date(),
    'teacherConfirmation.replyId': String(payload.data.id).slice(0, 200),
  } }, { new: true }).select('_id').lean();
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
