import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { audit } from '../utils/audit.js';
import { normalizeEmail, assertPassword } from '../utils/validators.js';
import { requestOtp, verifyOtp, consumeToken } from './otpService.js';

/**
 * Activation / password-reset flows. Activation tokens are SEPARATE from the
 * 7-day login JWT: type='activation' | 'password-reset', purpose-bound,
 * 15-minute expiry, minimal payload { userId, purpose, jti } — never a
 * password, never OTP, never section data, and never usable as a login
 * session (protect rejects typed tokens).
 */

const TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const ACTIVATION_PURPOSE = { cr: 'cr-activation', student: 'student-activation' };

const GENERIC_OTP_RESPONSE = 'If the account is eligible, an OTP has been sent to your email.';

function issueShortToken({ type, purpose, userId }) {
  const jti = crypto.randomBytes(24).toString('hex');
  const token = jwt.sign({ type, purpose, userId: String(userId), jti }, env.jwtSecret, {
    expiresIn: TOKEN_TTL_SECONDS,
  });
  return { token, jti };
}

/* -------------------- CR / Student activation -------------------- */

/**
 * OTP request for account activation. Existence-safe: ineligible emails
 * get the SAME generic response and never trigger an email. Rate limits
 * (429) are enforced for eligible requests.
 */
export async function requestActivationOtp(role, req) {
  const email = normalizeEmail(req.body?.email);
  const purpose = ACTIVATION_PURPOSE[role];
  if (!email || !purpose) throw new ApiError(400, 'Email is required');

  const user = await User.findOne({ email });
  const eligible = user && user.role === role && user.registrationStatus === 'pending';

  if (!eligible) {
    // No account detail ever leaks — same response, no email
    await audit({ action: 'auth.otp.request', email, reason: `ineligible:${purpose}`, ip: req.ip, userAgent: req.get('user-agent') });
    return { message: GENERIC_OTP_RESPONSE, sent: false };
  }

  await requestOtp({ email, purpose, name: user.name }); // throws 429 on rate limits
  await audit({ action: 'auth.otp.request', email, reason: `eligible:${purpose}`, targetUser: user._id, ip: req.ip, userAgent: req.get('user-agent') });
  return { message: GENERIC_OTP_RESPONSE, sent: true };
}

/**
 * OTP verification for activation. On success: emailVerified=true and a
 * short-lived, purpose-bound, single-use activation token is issued.
 */
export async function verifyActivationOtp(role, req) {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.otp ?? '');
  const purpose = ACTIVATION_PURPOSE[role];
  if (!email || !code) throw new ApiError(400, 'Email and OTP are required');

  const user = await User.findOne({ email });
  if (!user || user.role !== role) {
    await audit({ action: 'auth.otp.verify.fail', email, reason: `role-mismatch:${purpose}`, ip: req.ip, userAgent: req.get('user-agent') });
    throw new ApiError(400, 'Invalid or expired code');
  }

  const { token, jti } = issueShortToken({ type: 'activation', purpose, userId: user._id });
  const result = await verifyOtp({ email, purpose, code, tokenJti: jti });
  if (!result.ok) {
    await audit({ action: 'auth.otp.verify.fail', email, reason: `${result.reason}:${purpose}`, targetUser: user._id, ip: req.ip, userAgent: req.get('user-agent') });
    throw new ApiError(400, 'Invalid or expired code');
  }

  user.emailVerified = true; // required by the flow — password comes next
  await user.save();

  await audit({ action: 'auth.otp.verify.success', email, reason: purpose, targetUser: user._id, ip: req.ip, userAgent: req.get('user-agent') });
  return { activationToken: token, expiresIn: TOKEN_TTL_SECONDS };
}

/**
 * Final password setup for a pending CR/student. Client can set NOTHING
 * except the password — role, section, rollNo, createdBy, registrationStatus
 * and emailVerified are all server-controlled here.
 */
export async function setActivationPassword(role, req) {
  const { activationToken, password } = req.body ?? {};
  if (!activationToken) throw new ApiError(400, 'Activation token is required');
  const purpose = ACTIVATION_PURPOSE[role];

  let payload;
  try {
    payload = jwt.verify(activationToken, env.jwtSecret);
  } catch {
    throw new ApiError(401, 'Activation link is invalid or expired');
  }
  if (payload.type !== 'activation' || payload.purpose !== purpose) {
    throw new ApiError(401, 'Activation link is invalid or expired');
  }

  const user = await User.findById(payload.userId);
  if (!user || user.role !== role) throw new ApiError(401, 'Activation link is invalid or expired');
  if (user.registrationStatus === 'active') {
    throw new ApiError(409, 'Account is already activated');
  }
  if (user.registrationStatus !== 'pending') {
    throw new ApiError(403, 'Account cannot be activated');
  }

  const strong = assertPassword(password); // validated BEFORE consuming the token

  await consumeToken(payload.jti); // single-use — invalidates the token

  user.password = await bcrypt.hash(strong, 12); // never plaintext
  user.registrationStatus = 'active'; // server-controlled
  user.emailVerified = true; // preserved
  user.activationAt = new Date();
  await user.save(); // role/section/rollNo/createdBy untouched

  await audit({
    actor: user._id, actorRole: role,
    action: role === 'cr' ? 'auth.cr.activate' : 'auth.student.activate',
    entityType: 'user', entityId: user._id, targetUser: user._id,
    after: { email: user.email, role: user.role, registrationStatus: 'active' },
    ip: req.ip, userAgent: req.get('user-agent'),
  });
  return user;
}

/* ------------------------ Password reset ------------------------- */

/** Existence-safe OTP request for active accounts. */
export async function requestPasswordResetOtp(req) {
  const email = normalizeEmail(req.body?.email);
  if (!email) throw new ApiError(400, 'Email is required');

  const user = await User.findOne({ email });
  const eligible = user && user.registrationStatus === 'active';

  if (!eligible) {
    await audit({ action: 'auth.password-reset.request', email, reason: 'ineligible', ip: req.ip, userAgent: req.get('user-agent') });
    return { message: 'If the account is eligible, an OTP has been sent to your email.', sent: false };
  }

  await requestOtp({ email, purpose: 'password-reset', name: user.name });
  await audit({ action: 'auth.password-reset.request', email, reason: 'eligible', targetUser: user._id, ip: req.ip, userAgent: req.get('user-agent') });
  return { message: 'If the account is eligible, an OTP has been sent to your email.', sent: true };
}

export async function verifyPasswordResetOtp(req) {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.otp ?? '');
  if (!email || !code) throw new ApiError(400, 'Email and OTP are required');

  const user = await User.findOne({ email });
  if (!user) {
    await audit({ action: 'auth.otp.verify.fail', email, reason: 'password-reset:unknown', ip: req.ip, userAgent: req.get('user-agent') });
    throw new ApiError(400, 'Invalid or expired code');
  }

  const { token, jti } = issueShortToken({ type: 'password-reset', purpose: 'password-reset', userId: user._id });
  const result = await verifyOtp({ email, purpose: 'password-reset', code, tokenJti: jti });
  if (!result.ok) {
    await audit({ action: 'auth.otp.verify.fail', email, reason: `password-reset:${result.reason}`, targetUser: user._id, ip: req.ip, userAgent: req.get('user-agent') });
    throw new ApiError(400, 'Invalid or expired code');
  }
  await audit({ action: 'auth.otp.verify.success', email, reason: 'password-reset', targetUser: user._id, ip: req.ip, userAgent: req.get('user-agent') });
  return { resetToken: token, expiresIn: TOKEN_TTL_SECONDS };
}

/** New password from a valid reset token. Suspended users cannot bypass. */
export async function setResetPassword(req) {
  const { resetToken, password } = req.body ?? {};
  if (!resetToken) throw new ApiError(400, 'Reset token is required');

  let payload;
  try {
    payload = jwt.verify(resetToken, env.jwtSecret);
  } catch {
    throw new ApiError(401, 'Reset link is invalid or expired');
  }
  if (payload.type !== 'password-reset' || payload.purpose !== 'password-reset') {
    throw new ApiError(401, 'Reset link is invalid or expired');
  }

  const user = await User.findById(payload.userId);
  if (!user) throw new ApiError(401, 'Reset link is invalid or expired');
  if (user.registrationStatus === 'suspended') {
    // Suspension can never be bypassed through password reset
    throw new ApiError(403, 'Account suspended');
  }
  if (user.registrationStatus !== 'active') {
    throw new ApiError(401, 'Reset link is invalid or expired');
  }

  const strong = assertPassword(password); // validated BEFORE consuming the token
  await consumeToken(payload.jti); // single-use

  user.password = await bcrypt.hash(strong, 12);
  await user.save();

  await audit({
    actor: user._id, actorRole: user.role,
    action: 'auth.password-reset.success',
    entityType: 'user', entityId: user._id, targetUser: user._id,
    ip: req.ip, userAgent: req.get('user-agent'),
  });
  // Minimal confirmation only — never the raw user document (hash leak).
  return { message: 'Password updated. You can now sign in.' };
}
