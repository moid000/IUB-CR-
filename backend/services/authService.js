import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { audit } from '../utils/audit.js';
import { normalizeEmail, assertPassword } from '../utils/validators.js';
import { AUTH_COOKIE, JWT_MAX_AGE_SECONDS } from '../utils/constants.js';

const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX_FAILURES = 5;

/**
 * JWT contains the MINIMUM identity information (userId, role).
 * Section ownership is intentionally excluded — it can change
 * administratively; protect always reloads the user from MongoDB.
 * The token is delivered ONLY via an httpOnly cookie.
 */
export function issueToken(user) {
  return jwt.sign({ userId: String(user._id), role: user.role }, env.jwtSecret, {
    expiresIn: JWT_MAX_AGE_SECONDS, // 7 days absolute — no sliding session yet
  });
}

export function authCookieOptions() {
  return { httpOnly: true, secure: env.isProd, sameSite: 'lax', path: '/' };
}

export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, { ...authCookieOptions(), maxAge: JWT_MAX_AGE_SECONDS * 1000 });
}

export function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, authCookieOptions());
}

/**
 * Serverless-safe login throttle — counts auth.login.fail audit events for the
 * same normalized email in the previous 15 minutes. Works across all Vercel
 * instances (MongoDB is the arbiter). Never permanently locks an account.
 */
// Owner decision 2026-09-15: login attempts are NOT throttled — wrong credentials simply
// return "Invalid email or password". Failures are still audited below for traceability.
export async function isLoginThrottled(email) {
  const since = new Date(Date.now() - THROTTLE_WINDOW_MS);
  const failures = await AuditLog.countDocuments({
    action: 'auth.login.fail',
    email,
    createdAt: { $gte: since },
  });
  return failures >= THROTTLE_MAX_FAILURES;
}

/**
 * Full login flow. Throws ApiError on every rejection path.
 * Plaintext passwords and tokens are never logged or returned.
 */
export async function login(rawEmail, rawPassword, meta = {}) {
  const email = normalizeEmail(rawEmail);
  if (!email || !rawPassword) throw new ApiError(400, 'Email and password are required');

  const fail = async (reason, targetUser = null) => {
    await audit({
      action: 'auth.login.fail',
      email,
      reason, // failure category only — NEVER the submitted password
      targetUser,
      entityType: 'user',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  };

  const user = await User.findOne({ email }).select('+password');
  if (!user) {
    await fail('unknown-email');
    throw new ApiError(401, 'Invalid email or password'); // generic — no existence leak
  }

  // Status checks come BEFORE the password check so pre-activated accounts
  // (password still null) get the right message.
  if (user.registrationStatus === 'pending') {
    await fail('account-pending', user._id);
    throw new ApiError(403, 'Account not activated yet');
  }
  if (user.registrationStatus === 'suspended') {
    await fail('account-suspended', user._id);
    throw new ApiError(403, 'Account suspended');
  }
  if (!user.password) {
    await fail('password-not-set', user._id);
    throw new ApiError(401, 'Invalid email or password'); // generic — no existence leak
  }

  const passwordOk = await bcrypt.compare(rawPassword, user.password);
  if (!passwordOk) {
    await fail('bad-password', user._id);
    throw new ApiError(401, 'Invalid email or password');
  }

  user.lastLoginAt = new Date();
  await user.save();

  await audit({
    actor: user._id,
    actorRole: user.role,
    action: 'auth.login.success',
    targetUser: user._id,
    entityType: 'user',
    entityId: user._id,
    email,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { user, token: issueToken(user) };
}

/* ==================== STEP 18 — change password (self) =================== */

/**
 * POST /api/auth/change-password — authenticated self-service rotation.
 * Requires the CURRENT password (re-authentication), enforces the standard
 * password policy, and writes ONLY a bcrypt hash. The JWT session cookie is
 * untouched — the user stays signed in. Never returns the old or new value.
 */
export async function changePassword(user, currentPassword, newPassword) {
  const doc = await User.findById(user._id).select('+password');
  if (!doc) throw new ApiError(401, 'Account no longer exists');

  const ok = doc.password && await bcrypt.compare(String(currentPassword ?? ''), doc.password);
  if (!ok) throw new ApiError(401, 'Current password is incorrect');

  assertPassword(newPassword, 'new password');
  if (String(newPassword) === String(currentPassword)) {
    throw new ApiError(400, 'New password must be different from the current one');
  }

  doc.password = await bcrypt.hash(newPassword, 12);
  await doc.save();

  await audit({
    actor: doc._id, actorRole: doc.role, action: 'auth.change_password',
    entityType: 'user', entityId: doc._id,
  });
  return { changed: true };
}
