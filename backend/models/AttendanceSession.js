import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Short-lived attendance session created by the CR.
 *
 * SECURITY:
 * - `codeHash` is the SHA-256 of the attendance code — the PLAINTEXT CODE IS
 *   NEVER STORED and never returned by student-facing APIs.
 * - `codeHash` is select:false so it is excluded from queries by default;
 *   marking compares a fresh hash server-side.
 * - Sessions are never deleted: a CR can only cancel (status flip + audit).
 */
const attendanceSessionSchema = new Schema(
  {
    section: { type: ObjectId, ref: 'Section', required: true },
    subject: { type: ObjectId, ref: 'Subject', required: true },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true },
    opensAt: { type: Date, required: true },
    expiresAt: {
      type: Date,
      required: true,
      validate: {
        validator(value) {
          return value > this.opensAt;
        },
        message: 'expiresAt must be after opensAt',
      },
    },
    codeHash: { type: String, required: true, select: false },
    // Wrong-code counter — incremented ATOMICALLY ($inc); the session is
    // auto-cancelled when it reaches MAX_FAILED_ATTEMPTS (10).
    failedAttempts: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['open', 'cancelled'], default: 'open' },
  },
  { timestamps: true }
);

attendanceSessionSchema.index({ section: 1, date: -1 });
attendanceSessionSchema.index({ status: 1, expiresAt: 1 });

export default mongoose.model('AttendanceSession', attendanceSessionSchema);
