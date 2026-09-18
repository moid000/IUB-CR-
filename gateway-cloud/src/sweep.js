import { Assignment, Submission, Teacher, User, Section } from './models.js';
import { sendText as waSendText, sendDocument as waSendDocument, toJid, now } from './wa.js';

/**
 * Deadline sweep — same rules as the live backend engine:
 * - Only published assignments whose deadline passed within the last 24h.
 * - Idempotent claim (deadlineNotifiedAt) BEFORE sending — this also means
 *   the Vercel/UltraMsg sweeper and this gateway can never double-send.
 * - One summary message, then one message per submitted student.
 * - Gateway upgrade: files are sent as REAL WhatsApp documents (with link fallback).
 */

const MAX_PER_RUN = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const INTERMESSAGE_DELAY_MS = 400;
const MAX_LISTED = 50;

const dateFmt = new Intl.DateTimeFormat('en-PK', {
  timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short',
});
const pkt = (d) => { try { return dateFmt.format(new Date(d)); } catch { return String(d); } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listGroup(label, entries) {
  const lines = [`${label} (${entries.length}):`];
  entries.slice(0, MAX_LISTED).forEach((e, i) => lines.push(`${i + 1}. ${e.name} — ${e.rollNo}`));
  if (entries.length > MAX_LISTED) lines.push(`…and ${entries.length - MAX_LISTED} more`);
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
  lines.push(submitted.length ? listGroup('✅ Submitted', submitted) : '✅ Submitted (0)');
  if (missing.length) {
    lines.push('');
    lines.push(listGroup('❌ Not submitted', missing));
  }
  lines.push('', 'Submitted student files follow in the next messages.');
  return lines.join('\n');
}

async function downloadFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimetype: res.headers.get('content-type') || undefined };
}

async function sendSubmission(send, jid, { index, total, assignment, submission }) {
  const student = submission.student;
  const header = [
    `*Submission ${index}/${total}* — ${assignment.title}`,
    `Student: ${student?.name ?? '—'}`,
    `Roll No: ${student?.rollNo ?? '—'}`,
    `Submitted: ${pkt(submission.submittedAt)}${submission.isLate ? ' (late)' : ''}`,
  ].join('\n');

  const files = submission.files ?? [];
  if (files.length) {
    for (const f of files) {
      const caption = files.length === 1 ? header : `${header}\nFile: ${f.originalName ?? 'file'}`;
      try {
        const { buffer, mimetype } = await downloadFile(f.url);
        await send.sendDocument(jid, {
          buffer,
          fileName: f.originalName || `submission.${f.format || 'bin'}`,
          mimetype: f.mimeType || mimetype || 'application/octet-stream',
          caption,
        });
      } catch {
        // Download failed (laptop offline to Cloudinary, etc.) — fall back to link
        await send.sendText(jid, `${header}\nFiles:\n• ${f.originalName ?? 'file'}: ${f.url}`);
      }
      await sleep(INTERMESSAGE_DELAY_MS);
    }
  } else if (submission.textAnswer) {
    await send.sendText(jid, `${header}\nAnswer: ${submission.textAnswer.slice(0, 800)}`);
  } else {
    await send.sendText(jid, header);
  }
}

/** One sweep pass. Safe to call every minute — claims make it idempotent. */
export async function runSweep(send = { sendText: waSendText, sendDocument: waSendDocument }) {
  const nowMs = Date.now();
  const due = await Assignment.find({
    status: 'published',
    deadline: { $lte: nowMs, $gte: new Date(nowMs - WINDOW_MS) },
    deadlineNotifiedAt: null,
  })
    .sort({ deadline: 1 })
    .limit(MAX_PER_RUN)
    .populate('subject', 'name code');

  if (!due.length) return;

  for (const assignment of due) {
    // Claim IMMEDIATELY (atomic conditional update — same as backend engine)
    const claim = await Assignment.updateOne(
      { _id: assignment._id, deadlineNotifiedAt: null },
      { $set: { deadlineNotifiedAt: new Date() } }
    );
    if (claim.modifiedCount === 0) continue; // someone else claimed it first

    const teacher = await Teacher.findOne({ subject: assignment.subject?._id }).populate('subject', 'name');
    if (!teacher?.whatsapp) {
      console.log(`• [${now()}] "${assignment.title}" — no teacher linked, marked done (CR Teachers page par add karo)`);
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
      User.find({ section: assignment.section, role: 'student' }).select('name rollNo'),
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

    const jid = toJid(teacher.whatsapp);
    try {
      console.log(`➡️  [${now()}] "${assignment.title}" → ${teacher.name} (${teacher.whatsapp}): summary`);
      await send.sendText(jid, buildSummary({
        assignment, section,
        department: section?.department,
        cr: section?.cr, gr: section?.gr,
        submitted, missing,
      }));
      await sleep(INTERMESSAGE_DELAY_MS);

      for (let i = 0; i < submissions.length; i += 1) {
        try {
          console.log(`➡️  [${now()}] submission ${i + 1}/${submissions.length} (${submitted[i]?.name})`);
          await sendSubmission(send, jid, { index: i + 1, total: submissions.length, assignment, submission: submissions[i] });
        } catch (err) {
          console.log(`   ⚠️  submission ${i + 1} failed: ${err.message} — aage barh raha hun`);
        }
        await sleep(INTERMESSAGE_DELAY_MS);
      }
      console.log(`✅ [${now()}] "${assignment.title}" complete — ${1 + submissions.length} messages`);
    } catch (err) {
      // Summary failed → release claim so the next pass retries
      await Assignment.updateOne({ _id: assignment._id }, { $set: { deadlineNotifiedAt: null } });
      console.log(`❌ [${now()}] "${assignment.title}" summary FAILED (${err.message}) — next pass retry`);
    }
  }
}
