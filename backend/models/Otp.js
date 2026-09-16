import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Email OTP. NEVER stores a plaintext code — only a bcrypt hash.
 *
 * - TTL: documents self-delete at expiresAt (single-use before that).
 * - Rate limiting (60s resend cooldown, max 5 sends/hour/email+purpose,
 *   max 5 verification attempts) is computed from these documents at
 *   runtime — serverless-safe, no in-memory counters, works across
 *   all Vercel instances.
 * - tokenJti/tokenUsedAt act as the server-side single-use record for the
 *   short-lived activation / password-reset tokens issued after a
 *   successful verification.
 */
const otpSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    purpose: {
      type: String,
      enum: ['cr-activation', 'gr-activation', 'student-activation', 'password-reset'],
      required: true,
    },
    codeHash: { type: String, required: true, select: false }, // bcrypt hash of the OTP
    expiresAt: { type: Date, required: true }, // 10 minutes after creation
    usedAt: { type: Date, default: null }, // set on FIRST successful verification
    attempts: { type: Number, default: 0, min: 0 }, // verification attempts (max 5)
    tokenJti: { type: String, index: true, default: null }, // jti of the issued activation/reset token
    tokenUsedAt: { type: Date, default: null }, // set when that token is consumed
  },
  { timestamps: true }
);

// Supports the cooldown (60s) and hourly (5/hour) rate-limit queries
otpSchema.index({ email: 1, purpose: 1, createdAt: -1 });

// Auto-delete expired OTPs
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('Otp', otpSchema);
