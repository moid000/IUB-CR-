import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * OWNER RELIABILITY SPEC §9 (2026-10-10): OUTBOUND DELIVERY IS A TASK TOO.
 * Every teacher-facing WhatsApp send in the critical flows (question acks,
 * CR answers, approval questions, publish results) is logged here BEFORE
 * the gateway call. A send is 'sent' ONLY on gateway confirmation; a failed
 * send is sweep-retried (bounded) instead of being silently dropped — a
 * temporary WhatsApp failure can no longer lose a reply the teacher was
 * promised.
 *
 * dedupeKey makes one-shot sends (e.g. the first-contact welcome) exactly-once.
 */
const outboxSchema = new Schema(
  {
    phone: { type: String, required: true, index: true }, // digits
    kind: { type: String, default: 'teacher', maxlength: 40 }, // ack | answer | approval | published | welcome | cr_nudge | escalation ...
    refKey: { type: String, default: '', maxlength: 120, index: true }, // e.g. 'teacher-material:<id>' / 'question:<id>'
    dedupeKey: { type: String, default: '', maxlength: 140, index: true }, // exactly-once guard
    body: { type: String, default: '', maxlength: 4000 },
    status: {
      type: String,
      enum: ['queued', 'sent', 'failed'],
      default: 'queued',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
  // WASENDER 2026-10-11: media rows (broadcast attachments) retry through
  // the same outbox — a throttled/partial burst is finished by the sweep
  // instead of silently losing files.
  url: { type: String, default: '' },
  mediaKind: { type: String, default: '' },
  filename: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    lastTriedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

outboxSchema.index({ status: 1, lastTriedAt: 1 });

// retention: TTL removes successful rows after 7 days
outboxSchema.index({ sentAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export default mongoose.model('OutboxMessage', outboxSchema);
