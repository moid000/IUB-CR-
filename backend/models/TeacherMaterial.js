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
 *     study_material + subject resolved   → awaiting_approval → published | declined
 *     study_material + subject ambiguous  → awaiting_subject  → awaiting_approval → …
 *     clearly not study material / unclear → ignored (no upload ever)
 *     upload failure                      → failed (honest reply, never a fake success)
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
    status: {
      type: String,
      enum: ['received', 'awaiting_approval', 'awaiting_subject', 'published', 'declined', 'failed', 'ignored'],
      default: 'received',
      index: true,
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
