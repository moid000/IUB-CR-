import { Timetable, Teacher } from '../models/index.js';
import { now, karachiWallClock } from '../utils/clock.js';
import { sendText, isConfigured } from './whatsappService.js';

/**
 * OWNER FEATURE (2026-10-04): "jis teacher ki class ki jo bhi timing ho,
 * us se 20 min pehle har teacher ko message chala jaye" — a SHORT, clear
 * pre-class reminder so no teacher misses their class.
 *
 * Runs on the EXISTING cron-job.org → GET /api/whatsapp/deadline-sweep ping
 * (every ~5 min): zero new infrastructure, free, Base44-independent, and
 * never blocks the assignment-deadline sweep (route wraps it in .catch).
 *
 * Self-healing, exactly like the deadline sweep:
 *  - one reminder per slot EVER — Timetable.classReminder.sentAt is set only
 *    after a successful gateway send, so the 20-minute window is covered by
 *    the 20/15/10/5-minute passes and a gateway hiccup simply retries
 *  - no teacher linked yet → silently re-checked each pass (a teacher added
 *    inside the window still gets the reminder), never counted as failure
 *  - class already started or more than 20 min away → skipped
 */

const REMINDER_WINDOW_MIN = 20;

const fmtTime = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
};

/** ONE short line — deliberately no long template, no link: the teacher must
 * grasp it at a glance. Same respectful greeting as every teacher message. */
export function buildClassReminderMessage({ teacher, subject, section, time, room }) {
  return [
    `Assalam-o-Alaikum Respected *${teacher}*`,
    `*Reminder:* your *${subject}* class (${section}) starts at *${fmtTime(time)}* today${room ? ` — ${room}` : ''}.`,
    '— Tri3M Class Agent',
  ].join('\n');
}

export async function runClassReminderSweep({ nowEpoch = now(), only = null } = {}) {
  if (!isConfigured()) return { configured: false, due: 0, sent: 0, failed: 0, skippedNoTeacher: 0 };

  const { dateStr, minutes } = karachiWallClock(nowEpoch);
  // Karachi-local today, active, never reminded yet — slots with a failed
  // send stay unmarked and are retried by the next pass.
  const slots = await Timetable.find({
    date: dateStr, status: 'active', 'classReminder.sentAt': { $exists: false },
    // a teacher who already declined the class must NOT be reminded about it
    'teacherConfirmation.status': { $ne: 'declined' },
  }).populate('subject', 'name').populate('section', 'name semester').lean();

  const due = slots.filter((slot) => {
    const [h, m] = slot.startTime.split(':').map(Number);
    const remaining = h * 60 + m - minutes;
    return remaining > 0 && remaining <= REMINDER_WINDOW_MIN; // strictly before start
  });

  const report = { configured: true, due: due.length, sent: 0, failed: 0, skippedNoTeacher: 0 };

  for (const slot of due) {
    if (only && String(slot._id) !== String(only)) continue; // test seam
    const teacher = await Teacher.findOne({ subject: slot.subject?._id, section: slot.section?._id }).lean();
    const phone = teacher?.whatsapp?.replace(/\D/g, '');
    if (!teacher || !phone) { report.skippedNoTeacher += 1; continue; }

    const body = buildClassReminderMessage({
      teacher: teacher.name,
      subject: slot.subject?.name ?? 'class',
      section: slot.section?.name ?? '',
      time: slot.startTime,
      room: slot.room,
    });
    try {
      await sendText(phone, body);
      // mark ONLY after a successful gateway send — failures retry next pass
      await Timetable.updateOne({ _id: slot._id }, { $set: { 'classReminder.sentAt': new Date() } });
      report.sent += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
