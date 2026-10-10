import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * OWNER RELIABILITY SPEC (2026-10-09, §5–§8): a teacher question the AI
 * cannot answer from VERIFIED records becomes a persistent CR-confirmation
 * task — never a guessed answer.
 *
 * Two-way lifecycle:
 *   pending_cr → cr_responded → answer_sent → closed
 *
 * - Each question is its OWN task (several can be open at once, across
 *   teachers and sections — they never overwrite each other).
 * - The responsible CR comes from the section's real cr/gr assignment
 *   (never random) and only sees questions for THEIR sections.
 * - The CR answers over WhatsApp; the reply is stored with identity +
 *   timestamp and delivered back to the ORIGINAL teacher conversation.
 * - Status flips to answer_sent/closed ONLY after successful dispatch.
 * - Re-asking the SAME unresolved question reuses the task (no CR spam);
 *   a genuinely different question creates a new one.
 * - Restart-safe: everything lives here in MongoDB.
 */
const questionSchema = new Schema(
  {
    teacher: { type: ObjectId, ref: 'Teacher', required: true },
    teacherName: { type: String, default: '', maxlength: 120 },
    phone: { type: String, required: true, index: true }, // teacher's WhatsApp digits (answer delivery target)
    section: { type: ObjectId, ref: 'Section', required: true },
    subject: { type: ObjectId, ref: 'Subject', default: null },
    question: { type: String, required: true, maxlength: 800 }, // the teacher's actual words
    questionKey: { type: String, default: '', maxlength: 220, index: true }, // normalized text — same-question reuse
    status: {
      type: String,
      enum: ['pending_cr', 'cr_responded', 'answer_sent', 'closed'],
      default: 'pending_cr',
      index: true,
    },
    refCode: { type: String, required: true, unique: true }, // e.g. 'Q-4F7A' — the CR can target a specific question
    crUser: { type: ObjectId, ref: 'User', default: null }, // the CR/GR this was dispatched to
    askedAt: { type: Date, default: Date.now },
    crNotifiedAt: { type: Date, default: null }, // WhatsApp dispatch to the CR SUCCEEDED at
    crNotifyAttempts: { type: Number, default: 0 },
    crReminders: { type: Number, default: 0 }, // justified reminder policy (sweep, max 2)
    lastCrNotifyAt: { type: Date, default: null },
    crReply: { type: String, default: '', maxlength: 1200 }, // the CR's answer, verbatim
    crReplyMsgId: { type: String, default: '', maxlength: 220 }, // duplicate-reply idempotency
    crReplyAt: { type: Date, default: null },
    answerSentAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    teacherAckMsgId: { type: String, default: '', maxlength: 220 }, // the ack sent to the teacher — idempotency
    escalatedBy: { type: String, default: 'general-chat' }, // which flow created the task
    lastFollowUpAt: { type: Date, default: null }, // last CR nudge time (spec §4 follow-up policy)
    escalatedToUser: { type: ObjectId, ref: 'User', default: null }, // escalation target (section GR / admin)
    escalatedToName: { type: String, default: '' },
    escalatedAt: { type: Date, default: null },
    escalationNote: { type: String, default: '', maxlength: 500 },
  },
  { timestamps: true }
);

// the CR reply lookup: their pending questions, oldest first
questionSchema.index({ crUser: 1, status: 1, askedAt: 1 });
// same-question reuse check per teacher
questionSchema.index({ teacher: 1, status: 1, questionKey: 1 });

export default mongoose.model('TeacherQuestion', questionSchema);
