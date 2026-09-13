import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Email OTP. NEVER stores a plaintext code — only a bcrypt hash.
 *
 * - TTL: documents self-delete at expiresAt (single-use before that).
 * - Rate limiting (60s resend cooldown, max 5 sends/hour/email, max 5 attempts)
 *   is computed from these documents at runtime — serverless-safe, no memory.
 * - Index below supports the cooldown/rate queries: {email, purpose, createdAt}.
 */
const otpSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    purpose: {
      type: String,
      enum: ['registration', 'login', 'password-reset'],
      required: true,
    },
    codeHash: { type: String, required: true, select: false }, // bcrypt hash of the OTP
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    resendCount: { type: Number, default: 0, min: 0 },
    lastSentAt: { type: Date },
  },
  { timestamps: true }
);

otpSchema.index({ email: 1, purpose: 1, createdAt: -1 });

// Auto-delete expired OTPs
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('Otp', otpSchema);
