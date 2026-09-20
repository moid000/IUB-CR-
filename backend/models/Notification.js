import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * In-app notification (auth OTP emails are the only out-of-app channel).
 *
 * Duplicates are prevented via a partial unique index on {recipient, dedupeKey}:
 * e.g. 30-minute timetable reminders use `reminder:<slotId>:<YYYY-MM-DD>` —
 * concurrent polls on different serverless instances are safe because MongoDB
 * itself is the arbiter.
 */
const notificationSchema = new Schema(
  {
    recipient: { type: ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: ['announcement', 'assignment', 'note', 'timetable', 'attendance', 'reminder', 'system'],
      required: true,
    },
    title: { type: String, trim: true },
    message: { type: String, trim: true },
    refType: { type: String, trim: true },
    refId: { type: ObjectId },
    dedupeKey: { type: String, trim: true },
    read: { type: Boolean, default: false },
    readAt: { type: Date },
    expiresAt: { type: Date }, // TTL below — old notifications self-delete
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });
// Covers the unread-count-by-type aggregate entirely from the index.
notificationSchema.index({ recipient: 1, read: 1, type: 1 });
notificationSchema.index(
  { recipient: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $exists: true } } }
);

// Auto-delete expired notifications
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('Notification', notificationSchema);
