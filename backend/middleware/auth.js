import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { env } from '../config/env.js';
import { ApiError } from './error.js';
import { AUTH_COOKIE } from '../utils/constants.js';

function extractToken(req) {
  // httpOnly cookie is the ONLY token store used by the frontend
  // (SameSite=Lax + Secure in production). The Bearer fallback exists
  // exclusively for server-side tooling and API testing.
  if (req.cookies?.[AUTH_COOKIE]) return req.cookies[AUTH_COOKIE];
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/**
 * Verifies the JWT and ALWAYS loads the current user fresh from MongoDB.
 * Section/role can change administratively at any time, so a stale JWT
 * payload is never trusted beyond identifying the user.
 * Identity NEVER comes from req.body (userId/role are ignored entirely).
 */
export async function protect(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw new ApiError(401, 'Authentication required');

    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch {
      throw new ApiError(401, 'Invalid or expired session');
    }
    // Activation / password-reset tokens are NEVER usable as login sessions
    if (payload.type) throw new ApiError(401, 'Invalid session token');

    const user = await User.findById(payload.userId); // password excluded via select:false
    if (!user) throw new ApiError(401, 'Account no longer exists');
    if (user.registrationStatus === 'suspended') {
      throw new ApiError(403, 'Account suspended');
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Role-based authorization: role('admin', 'cr') etc. Consistent 403 on mismatch. */
export const role = (...allowed) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Authentication required'));
  if (!allowed.includes(req.user.role)) return next(new ApiError(403, 'Forbidden'));
  next();
};

export const adminOnly = role('admin');
export const crOnly = role('cr');
export const studentOnly = role('student');

/**
 * Marks the request as section-scoped.
 * The scope is derived ONLY from the authenticated user (req.user.section),
 * loaded fresh from MongoDB — client-supplied section IDs are NEVER trusted
 * for authorization. See utils/scopedQuery.js.
 */
export function sectionScope(req, res, next) {
  req.sectionScope = req.user?.section ?? null;
  next();
}
