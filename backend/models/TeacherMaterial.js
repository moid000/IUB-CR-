import mongoose from 'mongoose';
import FileMetaSchema from './FileMeta.js';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * OWNER MASTER UPGRADE (2026-10-08, §4–§8): a file a teacher sends on
 * WhatsApp travels through this state machine BEFORE anything reaches the
 * student portal. Publication NEVER happens without an explicit teacher
 * approval bound to THIS record — the approval question names the file,
 * and only the record it was asked about can be published by it.
 *
 * status flow:
 *   received → (classification)
 *     study_material + subject resolved   → awaiting_approval → uploading → published | failed
 *     study_material + subject ambiguous  → awaiting_subject  → awaiting_approval → …
 *     clearly not study material / unclear → ignored (no upload ever)
 *     upload failure                      → failed (honest reply, never a fake success)
 *     no teacher answer for 24h           → expired (CR told, file dropped)
 *
 * RELIABILITY (owner spec 2026-10-09): every attachment owns its OWN task
 * row and lifecycle — no global processed-flag can ever block a later file.
 * 'uploading' is an atomic claim (webhook redelivery can't double-publish),
 * crNotify carries a PERSISTED CR-notification task retried by the sweep,
 * and the 5-min sweep resumes received/uploading rows after a crash.
 *
 * Idempotency: waMsgId is UNIQUE — a webhook redelivery of the SAME message
 * never creates a second record, a second question, or a second upload.
 * sha256 dedupes the same FILE resent as a new message.
 */
const materialSchema = new Schema(
  {
    teacher: { type: ObjectId, ref: 'Teacher', required: true },
    phone: { type: String, required: true, index: true }, // WhatsApp digits, matches Teacher.whatsapp
    section: { type: ObjectId, ref: 'Section', required: true }, // authorized destination (server-derived)
    waMsgId: { type: String, required: true, unique: true, maxlength: 220 },
    mediaUrl: { type: String, default: '' }, // gateway CDN link (private files still need it to re-download at upload time)
    filename: { type: String, required: true, maxlength: 300 },
    mime: { type: String, default: '' },
    ext: { type: String, default: '' },
    size: { type: Number, default: 0 }, // bytes as reported at classification time
    sha256: { type: String, default: '', index: true }, // content hash — duplicate detection
    caption: { type: String, default: '', maxlength: 600 }, // the teacher's text with the file
    classification: {
      verdict: { type: String, enum: ['study_material', 'not_material', 'unclear', null], default: null },
      engine: { type: String, default: '' }, // 'gemini' | 'filename-heuristic'
      reason: { type: String, default: '', maxlength: 600 },
      extractedSummary: { type: String, default: '', maxlength: 1200 },
    },
    proposedSubject: { type: ObjectId, ref: 'Subject', default: null }, // server-resolved from the teacher's OWN subjects
    sectionSubjectName: { type: String, default: '', maxlength: 120 }, // OWNER (2026-10-08 night): subject name matched across MULTIPLE sections — the section question is open for it
    status: {
      type: String,
      enum: ['received', 'awaiting_approval', 'awaiting_subject', 'awaiting_section', 'uploading', 'published', 'declined', 'failed', 'ignored', 'expired', 'offered'],
      default: 'received',
      index: true,
    },
    uploadClaimedAt: { type: Date, default: null }, // atomic publish claim — a redelivery/concurrent worker can't double-publish
    uploadAttempts: { type: Number, default: 0 }, // bounded publish retries (sweep)
    // PERSISTED CR-notification task (owner spec §3): the CR must reliably
    // learn about published/failed/declined material. The first attempt runs
    // inline; failures are retried by the sweep WITHOUT re-uploading.
    crNotify: {
      event: { type: String, default: '' }, // published | failed | declined | expired
      status: { type: String, enum: ['', 'pending', 'delivered'], default: '' },
      attempts: { type: Number, default: 0 },
      lastTriedAt: { type: Date, default: null },
      title: { type: String, default: '', maxlength: 300 },
      lines: { type: String, default: '', maxlength: 1200 }, // the exact WhatsApp text, so retries never rebuild it
    },
    askedAt: { type: Date, default: null }, // when the agent last asked about THIS file (approval recency binding)
    lastReplyMsgId: { type: String, default: '', maxlength: 220 }, // teacher's answer message id — duplicate-reply idempotency
    publishedNote: { type: ObjectId, ref: 'Note', default: null },
    attachment: FileMetaSchema, // the VERIFIED Cloudinary FileMeta, set ONLY after a confirmed upload
    uploadError: { type: String, default: '', maxlength: 600 },
    audit: [{
      at: { type: Date, default: Date.now },
      event: { type: String, required: true }, // received | classified | asked | approved | declined | published | failed | duplicate
      detail: { type: String, default: '', maxlength: 600 },
    }],
  },
  { timestamps: true }
);

// One phone can hold several pending files, but the LATEST askedAt wins an
// approval reply — the approval question always names the file it refers to.
materialSchema.index({ phone: 1, status: 1, askedAt: -1 });

export default mongoose.model('TeacherMaterial', materialSchema);
