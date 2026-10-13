import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Fingerprint template -> student binding. ONE active binding per
 * (device, fingerprintId) and re-enrolling a student flips their old
 * binding to 'revoked' — append-only, same rule as attendance.
 *
 * Section-scoped: a fingerprint enrolled on 3M's device means nothing to
 * any other section's device, even with the same template index.
 */
const fingerprintBindingSchema = new Schema(
  {
    section: { type: ObjectId, ref: 'Section', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    deviceId: { type: ObjectId, ref: 'AttendanceDevice', required: true },
    fingerprintId: { type: Number, required: true, min: 1, max: 192 },
    enrolledBy: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    revokedAt: { type: Date, default: null },
    revocationReason: { type: String, trim: true, maxlength: 120 },
  },
  { timestamps: true }
);

// one ACTIVE template slot per device — re-enrolling the same sensor slot
// (or re-enrolling a student) revokes the old binding first
fingerprintBindingSchema.index(
  { deviceId: 1, fingerprintId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);
fingerprintBindingSchema.index({ user: 1, status: 1 });

export default mongoose.model('FingerprintBinding', fingerprintBindingSchema);
