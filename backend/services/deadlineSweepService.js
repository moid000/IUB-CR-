import { Assignment, Submission, User, Teacher, Section } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import * as whatsapp from './whatsappService.js';
import { nowDate } from '../utils/clock.js';

/**
 * WhatsApp deadline sweep.
 *
 * Called by an external pinger (cron-job.org, every ~5 minutes) via the
 * secret-protected /api/whatsapp/deadline-sweep endpoint. Idempotent: an
 * assignment is claimed (deadlineNotifiedAt set) BEFORE any message is sent,
 * so concurrent/duplicate pings never double-send.
 *
 * Only assignments whose deadline passed within the last 24h are processed —
 * a pinger enabled weeks late must never blast a backlog of old assignments.
 *
 * Per the owner's confirmed design:
 * - NO message when an assignment is created (teachers are not disturbed early).
 * - On deadline end the teacher receives ONE summary message (assignment,
 *   dept/semester/section, CR/GR names, posted & deadline dates, submitted
 *   list AND not-submitted list with names + roll numbers).
 * - Then ONE message PER submitted student (name, roll no, file links) —
 *   WhatsApp allows one file per message, so files go as links.
 * - Subject with no linked teacher: nothing to send — marked notified and
 *   reported as skipped (CR sees the teacher column empty on their portal).
 */

const MAX_ASSIGNMENTS_PER_RUN = 3; // stay well inside serverless time limits
const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
const INTERMESSAGE_DELAY_MS = 400; // keep the gateway happy — no burst sending
const MAX_LISTED_PER_GROUP = 50; // WhatsApp body limit ~4096 chars

const PKT = 'Asia/Karachi';
const dateFmt = new Intl.DateTimeFormat('en-PK', {
  timeZone: PKT, dateStyle: 'medium', timeStyle: 'short',
});

function pkt(date) {
  try { return dateFmt.format(new Date(date)); } catch { return String(date); }
}

function listGroup(label, entries, total) {
  const lines = [`${label} (${total}):`];
  entries.slice(0, MAX_LISTED_PER_GROUP).forEach((e, i) => {
    lines.push(`${i + 1}. ${e.name} — ${e.rollNo}`);
  });
  if (entries.length > MAX_LISTED_PER_GROUP) {
    lines.push(`…and ${entries.length - MAX_LISTED_PER_GROUP} more`);
  }
  return lines.join('\n');
}

function buildSummary({ assignment, section, department, cr, gr, submitted, missing }) {
  const lines = [
    '*Assignment Deadline Report*',
    `*${assignment.title}*`,
    `Subject: ${assignment.subject?.name ?? '—'}`,
    `Dept: ${department?.name ?? '—'} | Semester: ${section?.semester ?? '—'} | Section: ${section?.name ?? '—'}`,
    `CR: ${cr?.name ?? '—'}${gr ? ` | GR: ${gr.name}` : ''}`,
    `Posted: ${pkt(assignment.createdAt)}`,
    `Deadline: ${pkt(assignment.deadline)}`,
    '',
  ];
  if (submitted.length) lines.push(listGroup('✅ Submitted', submitted, submitted.length));
  else lines.push('✅ Submitted (0)');
  if (missing.length) {
    lines.push('');
    lines.push(listGroup('❌ Not submitted', missing, missing.length));
  }
  lines.push('', 'Submitted student files follow in the next messages.');
  return lines.join('\n');
}

function buildSubmissionMessage({ index, total, assignment, submission }) {
  const lines = [
    `*Submission ${index}/${total}* — ${assignment.title}`,
    `Student: ${submission.student?.name ?? '—'}`,
    `Roll No: ${submission.student?.rollNo ?? '—'}`,
    `Submitted: ${pkt(submission.submittedAt)}${submission.isLate ? ' (late)' : ''}`,
  ];
  const files = submission.files ?? [];
  if (files.length) {
    lines.push('Files:');
    files.forEach((f) => lines.push(`• ${f.originalName ?? 'file'}: ${f.url}`));
  } else if (submission.textAnswer) {
    lines.push(`Answer: ${submission.textAnswer.slice(0, 800)}`);
  }
  return lines.join('\n');
}

/**
 * Processes every due (published, deadline passed within the window, not yet
 * notified) assignment. Returns a machine-readable report for monitoring.
 */
export async function runDeadlineSweep({ now = nowDate() } = {}) {
  if (!whatsapp.isConfigured()) {
    return { configured: false, processed: [], skippedNoTeacher: 0 };
  }

  const due = await Assignment.find({
    status: 'published',
    deadline: { $lte: now, $gte: new Date(now.getTime() - SWEEP_WINDOW_MS) },
    deadlineNotifiedAt: null,
  })
    .sort({ deadline: 1 })
    .limit(MAX_ASSIGNMENTS_PER_RUN)
    .populate('subject', 'name code');

  const report = { configured: true, processed: [], skippedNoTeacher: 0 };

  for (const assignment of due) {
    // Claim IMMEDIATELY so a concurrent ping never re-sends this assignment
    assignment.deadlineNotifiedAt = now;
    await Assignment.updateOne(
      { _id: assignment._id, deadlineNotifiedAt: null },
      { $set: { deadlineNotifiedAt: now } }
    );

    const teacher = await Teacher.findOne({ subject: assignment.subject?._id })
      .populate('subject', 'name');

    if (!teacher) {
      report.skippedNoTeacher += 1;
      report.processed.push({
        assignment: assignment.title,
        teacher: null,
        sent: 0,
        failed: 0,
        status: 'skipped-no-teacher',
      });
      continue;
    }

    const [section, submissions, students] = await Promise.all([
      Section.findById(assignment.section)
        .populate('department', 'name')
        .populate('cr', 'name')
        .populate('gr', 'name'),
      Submission.find({ assignment: assignment._id })
        .populate('student', 'name rollNo')
        .sort({ submittedAt: 1 }),
      User.find({ section: assignment.section, role: 'student' })
        .select('name rollNo'),
    ]);

    const submitted = submissions.map((s) => ({
      name: s.student?.name ?? 'Unknown',
      rollNo: s.student?.rollNo ?? '—',
    }));
    const submittedIds = new Set(submissions.map((s) => String(s.student?._id)));
    const missing = students
      .filter((s) => !submittedIds.has(String(s._id)))
      .map((s) => ({ name: s.name, rollNo: s.rollNo ?? '—' }))
      .sort((a, b) => String(a.rollNo).localeCompare(String(b.rollNo), undefined, { numeric: true }));

    let sent = 0;
    let failed = 0;
    let status = 'sent';

    try {
      // 1) Summary message first
      await whatsapp.sendText(
        teacher.whatsapp,
        buildSummary({
          assignment,
          section,
          department: section?.department,
          cr: section?.cr,
          gr: section?.gr,
          submitted,
          missing,
        })
      );
      sent += 1;

      // 2) One message per submitted student — staggered, never burst
      for (let i = 0; i < submissions.length; i += 1) {
        try {
          await whatsapp.sendText(
            teacher.whatsapp,
            buildSubmissionMessage({
              index: i + 1,
              total: submissions.length,
              assignment,
              submission: submissions[i],
            })
          );
          sent += 1;
        } catch {
          failed += 1; // one student's message failing must not stop the rest
        }
        if (i < submissions.length - 1) {
          await whatsapp.sleep(INTERMESSAGE_DELAY_MS);
        }
      }
    } catch (err) {
      // Summary failed (session down / gateway error) — release the claim so
      // the next ping retries the whole assignment, then move on.
      await Assignment.updateOne({ _id: assignment._id }, { $set: { deadlineNotifiedAt: null } });
      status = 'retry-scheduled';
      report.processed.push({
        assignment: assignment.title,
        teacher: teacher.name,
        sent,
        failed,
        status,
        error: err instanceof ApiError ? err.message : 'send failed',
      });
      continue;
    }

    report.processed.push({ assignment: assignment.title, teacher: teacher.name, sent, failed, status });
  }

  report.processedCount = report.processed.length;
  return report;
}
