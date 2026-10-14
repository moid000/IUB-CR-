import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * OWNER SPEC 2026-10-13/14 (unsolicited-notes fix + fast delivery):
 * ONE explicit notes request = ONE delivery job — persisted, per-file
 * tracked, idempotent. A job is created ONLY when the intent gate
 * (notesRequestIntent) has already cleared the message as a real file
 * request; casual chat, thanks, jokes and webhook redeliveries can never
 * create or re-run a job.
 *
 * Idempotency chain:
 * - one INBOUND message (msgId) can create at most ONE job (unique index)
 *   -> duplicate webhook deliveries can never double-send
 * - each file row keeps its own state; retries re-send ONLY failed files
 *   (state 'sent' is terminal for that job)
 * - completed jobs are never re-executed by later messages — a new
 *   explicit request creates a NEW job with a new msgId.
 */
const noteDeliveryJobSchema = new Schema(
  {
    section: { type: ObjectId, ref: 'Section', required: true },
    groupId: { type: String, trim: true, maxlength: 120, required: true },
    requester: { type: String, trim: true, maxlength: 24 }, // asker digits
    requesterName: { type: String, trim: true, maxlength: 80 },
    msgId: { type: String, trim: true, maxlength: 100 }, // inbound WhatsApp msg id
    question: { type: String, trim: true, maxlength: 400 },
    status: {
      type: String,
      enum: ['pending', 'processing', 'complete', 'failed'],
      default: 'pending',
    },
    files: [
      {
        noteId: { type: ObjectId, ref: 'Note' },
        fileId: { type: String, trim: true, maxlength: 64 },
        title: { type: String, trim: true, maxlength: 160 },
        filename: { type: String, trim: true, maxlength: 200 },
        url: { type: String, trim: true },
        mimeType: { type: String, trim: true },
        // stable per-file idempotency key (msgId:url) — Phase 4.8
        sendKey: { type: String, trim: true, maxlength: 220 },
        state: {
          type: String,
          enum: ['pending', 'sending', 'sent', 'failed'],
          default: 'pending',
        },
        attempts: { type: Number, default: 0 },
        providerMsgId: { type: String, trim: true, maxlength: 100 },
        providerAccepted: { type: Boolean, default: false },
        error: { type: String, trim: true, maxlength: 160 },
        sentAt: { type: Date },
        durationMs: { type: Number, default: 0 },
      },
    ],
    completionSent: { type: Boolean, default: false },
    latencyMs: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// ONE job per inbound message — the webhook-retry wall
noteDeliveryJobSchema.index(
  { msgId: 1 },
  { unique: true, partialFilterExpression: { msgId: { $type: 'string' } } }
);
noteDeliveryJobSchema.index({ section: 1, createdAt: -1 });
noteDeliveryJobSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('NoteDeliveryJob', noteDeliveryJobSchema);
