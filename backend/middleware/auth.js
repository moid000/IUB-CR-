import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { env } from '../config/env.js';
import { ApiError } from './error.js';

const COOKIE_NAME = 'token';

function extractToken(req) {
  // httpOnly cookie is the primary token store (SameSite=Lax + Secure in production).
  // The Bearer fallback exists for server-side/API tooling only.
  if (req.cookies?.[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/**
 * Verifies the JWT and loads the authenticated user.
 * Identity ALWAYS comes from the signed token — never from the request body.
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

    const user = await User.findById(payload.id); // password excluded via select:false
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

/** Role-based authorization: role('admin', 'cr') etc. */
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
 * The scope is derived ONLY from the authenticated user (req.user.section).
 * Client-supplied section IDs are NEVER trusted for authorization — see utils/scopedQuery.js.
 */
export function sectionScope(req, res, next) {
  req.sectionScope = req.user?.section ?? null;
  next();
}
