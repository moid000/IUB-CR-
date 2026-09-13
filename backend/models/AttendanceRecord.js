import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Append-only attendance record.
 *
 * - ONE record per student per session (DB-level guarantee below) — replay and
 *   concurrent duplicate marking are both rejected by the unique index.
 * - Records are never rewritten or deleted. Corrections happen via a status
 *   flip to 'revoked' (with reason + auditor) or a 'manual' method record —
 *   each change is audit-logged.
 * - `section` is denormalized for secure/scoped queries.
 */
const attendanceRecordSchema = new Schema(
  {
    session: { type: ObjectId, ref: 'AttendanceSession', required: true },
    student: { type: ObjectId, ref: 'User', required: true },
    section: { type: ObjectId, ref: 'Section', required: true },
    markedAt: { type: Date, default: Date.now },
    ip: { type: String },
    userAgent: { type: String },
    method: { type: String, enum: ['self', 'manual'], default: 'self' },
    status: { type: String, enum: ['present', 'revoked'], default: 'present' },
    revokedBy: { type: ObjectId, ref: 'User', default: null },
    revocationReason: { type: String, trim: true },
  },
  { timestamps: true }
);

attendanceRecordSchema.index({ session: 1, student: 1 }, { unique: true });
attendanceRecordSchema.index({ student: 1, markedAt: -1 });
attendanceRecordSchema.index({ session: 1 });

export default mongoose.model('AttendanceRecord', attendanceRecordSchema);
