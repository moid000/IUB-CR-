import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import Otp from '../models/Otp.js';
import { ApiError } from '../middleware/error.js';
import { normalizeEmail } from '../utils/validators.js';
import { sendOtpEmail } from './emailService.js';

const OTP_TTL_MS = 10 * 60 * 1000; // expires after 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // minimum 60 seconds between sends
const MAX_SENDS_PER_HOUR = 5; // per email + purpose (rolling hour)
const MAX_ATTEMPTS = 5; // verification attempts per OTP

function randomOtp() {
  // Cryptographically secure 6-digit code, zero-padded
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Creates and emails a secure OTP. All rate limits are computed from MongoDB
 * (serverless-safe — works across Vercel instances). The plaintext OTP
 * NEVER touches the database, audit logs, or error messages.
 *
 * On email delivery failure the OTP document is invalidated immediately —
 * a code the user was never emailed can never be verified.
 */
export async function requestOtp({ email, purpose, name }) {
  const normalized = normalizeEmail(email);

  // 60-second resend cooldown
  const cooldownSince = new Date(Date.now() - RESEND_COOLDOWN_MS);
  const recent = await Otp.findOne({
    email: normalized, purpose, createdAt: { $gte: cooldownSince },
  }).sort({ createdAt: -1 });
  if (recent) {
    throw new ApiError(429, 'Please wait a minute before requesting another code');
  }

  // Max 5 sends per rolling hour per email + purpose
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const sentLastHour = await Otp.countDocuments({
    email: normalized, purpose, createdAt: { $gte: hourAgo },
  });
  if (sentLastHour >= MAX_SENDS_PER_HOUR) {
    throw new ApiError(429, 'Too many codes requested. Please try again later.');
  }

  const otp = randomOtp();
  const codeHash = await bcrypt.hash(otp, 10);
  const doc = await Otp.create({
    email: normalized,
    purpose,
    codeHash,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  try {
    await sendOtpEmail({ to: normalized, name, otp, purpose });
  } catch (err) {
    // Sending failed — invalidate the OTP so an un-emailed code is never valid
    doc.usedAt = new Date();
    await doc.save();
    throw err;
  }
  return doc;
}

/**
 * Verifies a submitted OTP with race-safe, atomic transitions:
 *  1. only the latest unused, unexpired OTP for email+purpose is considered
 *  2. attempts are incremented atomically (max 5, concurrent-safe)
 *  3. success CLAIMS the document atomically (usedAt) — exactly one
 *     successful verification is possible, ever, per OTP
 *
 * On success the caller-supplied tokenJti is stored so the later
 * activation/reset token is single-use (claimed via consumeToken).
 */
export async function verifyOtp({ email, purpose, code, tokenJti }) {
  const normalized = normalizeEmail(email);
  const now = new Date();

  const doc = await Otp.findOne({
    email: normalized, purpose, usedAt: null, expiresAt: { $gt: now },
  })
    .sort({ createdAt: -1 })
    .select('+codeHash');
  if (!doc) return { ok: false, reason: 'missing-expired-used' };

  // Atomic attempt increment — rejects when the race loses or limit hit
  const claimed = await Otp.findOneAndUpdate(
    { _id: doc._id, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!claimed) return { ok: false, reason: 'too-many-attempts' };

  const match = await bcrypt.compare(String(code ?? ''), doc.codeHash);
  if (!match) return { ok: false, reason: 'bad-code' };

  // Atomic single-use claim — concurrent verifications cannot both succeed
  const used = await Otp.findOneAndUpdate(
    { _id: doc._id, usedAt: null },
    { $set: { usedAt: new Date(), ...(tokenJti ? { tokenJti } : {}) } },
    { new: true }
  );
  if (!used) return { ok: false, reason: 'already-used' };

  return { ok: true, doc: used };
}

/**
 * Consumes the server-side single-use record for an activation/reset token.
 * Throws 401 if the token was already used or never issued.
 */
export async function consumeToken(jti) {
  if (!jti) throw new ApiError(401, 'This link or code is no longer valid');
  const doc = await Otp.findOneAndUpdate(
    { tokenJti: jti, tokenUsedAt: null },
    { $set: { tokenUsedAt: new Date() } }
  );
  if (!doc) throw new ApiError(401, 'This link or code has already been used');
  return true;
}
