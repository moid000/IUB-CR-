import mongoose from 'mongoose';
import FileMetaSchema from './FileMeta.js';

const { Schema } = mongoose;

/**
 * Single User collection for all roles (admin / cr / student).
 *
 * CR records are pre-created by Admin; Student records are pre-created by CR
 * (section context auto-derived from the CR's own section). Registration only
 * activates the pre-created record via OTP verification — no free signups.
 *
 * Fields immutable to the account holder (enforced at service/route level,
 * never from client payloads): name, email, role, section, rollNo, createdBy.
 * The holder may only change: phone, password.
 */
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: { unique: true },
    },
    phone: { type: String, trim: true },
    // STEP 18 — self-service profile picture. Reuses the existing embedded
    // FileMeta subdocument (no new collection). Populated ONLY through the
    // verified avatar sign→upload→confirm flow; never client-injectable.
    avatar: FileMetaSchema,
    // bcrypt hash — set only by the auth service; never plaintext
    password: { type: String, select: false },
    role: { type: String, enum: ['admin', 'cr', 'gr', 'student'], required: true },
    section: { type: Schema.Types.ObjectId, ref: 'Section', default: null },
    rollNo: { type: String, trim: true, default: '' },
    registrationStatus: {
      type: String,
      enum: ['pending', 'active', 'suspended'],
      default: 'pending',
    },
    emailVerified: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    activationAt: { type: Date },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.index({ section: 1, role: 1 });
userSchema.index({ registrationStatus: 1, role: 1 });
userSchema.index({ createdBy: 1 });

// Unique roll number per section — students only (empty roll numbers excluded)
userSchema.index(
  { section: 1, rollNo: 1 },
  {
    unique: true,
    partialFilterExpression: { role: 'student', rollNo: { $exists: true, $gt: '' } },
  }
);

export default mongoose.model('User', userSchema);
