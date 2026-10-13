import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * A physical fingerprint attendance device (ESP32 + R503) bound to ONE
 * section, installed at the classroom door. See
 * docs/hardware-attendance-design.md (Phase 1).
 *
 * SECURITY:
 * - The device secret is shown ONCE at registration / rotation and is
 *   NEVER stored. Only its SHA-256 (the actual HMAC key the firmware
 *   derives via the same one-way hash) is kept — a DB leak exposes no
 *   usable secret and nothing is reversible.
 * - Revocation is instant: revoked devices fail every signed request.
 * - Fingerprint templates never leave the sensor; this model only knows
 *   how many enrollments happened (enrolledCount).
 */
const attendanceDeviceSchema = new Schema(
  {
    section: { type: ObjectId, ref: 'Section', required: true },
    label: { type: String, trim: true, maxlength: 60, default: 'Door device' },
    deviceId: { type: String, required: true, unique: true, trim: true }, // dev_xxxxxxxxxxxx
    secretHash: { type: String, required: true, select: false }, // sha256 hex = HMAC key
    secretLast4: { type: String, trim: true, maxlength: 4 }, // "…a1b2" for the panel
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    enrolledCount: { type: Number, default: 0, min: 0 },
    lastSeenAt: { type: Date, default: null },
    fwVersion: { type: String, trim: true, maxlength: 20 },
    // CR-guided enrollment: portal turns mode on with a 10-min PIN bound to
    // the student being enrolled; the device captures 2 placements and the
    // sensor's template index arrives with the PIN.
    enrollmentMode: { type: String, enum: ['off', 'on'], default: 'off' },
    enrollmentPinHash: { type: String, default: null }, // bcrypt of 4-digit PIN
    enrollmentPinExpiresAt: { type: Date, default: null },
    enrollmentUserId: { type: ObjectId, ref: 'User', default: null },
    enrollmentStartedBy: { type: ObjectId, ref: 'User', default: null },
    createdBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

attendanceDeviceSchema.index({ section: 1, status: 1 });

export default mongoose.model('AttendanceDevice', attendanceDeviceSchema);
