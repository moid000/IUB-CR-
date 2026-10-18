import User from '../models/User.js';
import Section from '../models/Section.js';
import { sendTracked } from './whatsappService.js';
import { audit } from '../utils/audit.js';

/**
 * CR PORTAL — PENDING STUDENT ACTIVATION REMINDER (owner feature 2026-10-18).
 * Sends a professional English WhatsApp reminder to every still-pending
 * pre-registered student of the CR's own section, reusing the existing
 * tracked-send pipeline (sendTracked → OutboxMessage row BEFORE the gateway
 * call, provider message id persisted, exactly-once dedupe window) and the
 * verified /student/activate destination. Server-side eligibility only:
 * role=student + section=CR's section + registrationStatus='pending' +
 * a valid stored phone number. Nothing is sent automatically — sends happen
 * only when the CR explicitly confirms the dialog action.
 */

const PORTAL_URL = process.env.APP_URL || 'https://www.tri2m.com'; // custom domain (live 2026-10-05)
const STUDENT_ACTIVATE_URL = `${PORTAL_URL}/student/activate`;
const PHONE_RE = /^\+?[0-9]{10,15}$/; // same validator contract as assertPhone
const REMINDER_ONCE_WINDOW_MS = 24 * 60 * 60 * 1000; // at most one reminder per student per day

/** Resolve the reminder targets for a section: still-pending students with a
 * usable phone. Recently-reminded students (last 24h, outbox-confirmed) are
 * reported as skipped, not re-counted as eligible. Returns { eligible,
 * skipped, ctx } — ctx carries the verified section facts used per message. */
export async function pendingReminderCandidates(sectionId) {
  const { OutboxMessage } = await import('../models/index.js');
  const section = await Section.findById(sectionId)
    .populate('department', 'name')
    .populate('cr', 'name')
    .lean();
  if (!section) return { eligible: [], skipped: [], ctx: null };

  const students = await User.find({ section: sectionId, role: 'student', registrationStatus: 'pending' })
    .select('name rollNo phone')
    .lean();

  const since = new Date(Date.now() - REMINDER_ONCE_WINDOW_MS);
  const eligible = [];
  const skipped = [];
  for (const s of students) {
    const phone = String(s.phone ?? '').replace(/[\s-]/g, '');
    if (!phone || !PHONE_RE.test(phone)) {
      skipped.push({ id: String(s._id), name: s.name, reason: 'missing or invalid phone number' });
      continue;
    }
    const dedupeKey = `activation-reminder:${s._id}`;
    const recentlySent = await OutboxMessage.findOne({ dedupeKey, status: 'sent', sentAt: { $gte: since } })
      .select('_id').lean();
    if (recentlySent) {
      skipped.push({ id: String(s._id), name: s.name, reason: 'already reminded in the last 24 hours' });
      continue;
    }
    eligible.push({ id: String(s._id), name: s.name, rollNo: s.rollNo ?? '', phone });
  }
  return {
    eligible,
    skipped,
    ctx: {
      department: section.department?.name || '',
      semester: section.semester,
      section: section.name,
      crName: section.cr?.name || '',
    },
  };
}

/** The owner-specified professional English message. Only verified,
 * per-student facts are included — a missing roll number or CR is OMITTED,
 * never invented. */
export function buildReminderMessage(student, ctx) {
  const lines = [
    '*Reminder: Activate Your CR Portal Account*',
    '',
    `Dear ${student.name},`,
    '',
    'Our records indicate that your CR Portal account was pre-registered but has not yet been activated.',
    '',
    'Please review your registration details below and activate your account to access the portal.',
    '',
    'Student Details',
    `• Name: ${student.name}`,
  ];
  if (student.rollNo) lines.push(`• Roll Number: ${student.rollNo}`);
  if (ctx.department) lines.push(`• Department: ${ctx.department}`);
  if (ctx.semester) lines.push(`• Semester: ${ctx.semester}`);
  if (ctx.section) lines.push(`• Section: ${ctx.section}`);
  if (ctx.crName) lines.push(`• Class Representative (CR): ${ctx.crName}`);
  lines.push(
    '',
    'Activate Your Account:',
    STUDENT_ACTIVATE_URL,
    '',
    'Please complete the activation process at your earliest convenience. If you have already activated your account, kindly disregard this reminder.',
    '',
    'If you need assistance, please contact your Class Representative.',
    '',
    'Best regards,',
    'CR Portal Administration',
  );
  return lines.join('\n');
}

/** Send the reminders for the CR's own section. Re-validates each student's
 * status at send time (a student who activated meanwhile is skipped), uses
 * the tracked exactly-once pipeline so double-clicks/retries/concurrent
 * requests can never double-send, and returns an honest per-outcome summary
 * (gateway-confirmed vs failed vs skipped). */
export async function sendActivationReminders(sectionId, actor) {
  const { eligible, skipped, ctx } = await pendingReminderCandidates(sectionId);
  if (!ctx) return { sectionMissing: true, sent: 0, failed: 0, skipped: [] };

  const sentNames = [];
  const failed = [];
  const finalSkipped = skipped.map(({ name, reason }) => ({ name, reason }));

  for (const s of eligible) {
    const fresh = await User.findById(s.id).select('registrationStatus').lean();
    if (!fresh || fresh.registrationStatus !== 'pending') {
      finalSkipped.push({ name: s.name, reason: 'no longer pending' });
      continue;
    }
    const body = buildReminderMessage(s, ctx);
    const res = await sendTracked(s.phone, body, {
      kind: 'activation_reminder',
      refKey: `activation-reminder:${s.id}`,
      dedupeKey: `activation-reminder:${s.id}`,
      once: true,
      windowMs: REMINDER_ONCE_WINDOW_MS,
    });
    if (res?.sent && res.alreadySent) finalSkipped.push({ name: s.name, reason: 'already reminded in the last 24 hours' });
    else if (res?.sent) sentNames.push(s.name);
    else failed.push({ name: s.name, reason: res?.error || 'gateway did not confirm send' });
  }

  await audit({
    actor: actor?._id ?? null,
    actorRole: 'cr',
    action: 'cr.students.activation_reminder',
    section: sectionId,
    after: { sent: sentNames.length, failed: failed.length, skipped: finalSkipped.length },
  });

  return { sent: sentNames.length, sentNames, failed, skipped: finalSkipped };
}
