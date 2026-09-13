import jwt from 'jsonwebtoken';
import * as authService from '../services/authService.js';
import { ApiError } from '../middleware/error.js';
import { publicUser, publicSection } from '../utils/user.js';
import { audit } from '../utils/audit.js';
import { AUTH_COOKIE } from '../utils/constants.js';
import { env } from '../config/env.js';
import User from '../models/User.js';

export async function login(req, res, next) {
  try {
    const { user, token } = await authService.login(req.body?.email, req.body?.password, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    authService.setAuthCookie(res, token); // httpOnly — never exposed to frontend JS
    res.json({ success: true, user: publicUser(user) }); // no token, no hash in JSON
  } catch (err) {
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    // Best-effort audit: identify the actor from the cookie without blocking logout
    const token = req.cookies?.[AUTH_COOKIE];
    if (token) {
      try {
        const payload = jwt.verify(token, env.jwtSecret);
        await audit({
          actor: payload.userId, actorRole: 'user', action: 'auth.logout',
          targetUser: payload.userId, entityType: 'user', ip: req.ip,
          userAgent: req.get('user-agent'),
        });
      } catch { /* expired/invalid token — still clear the cookie */ }
    }
    authService.clearAuthCookie(res);
    res.json({ success: true, message: 'Logged out' }); // no token in response
  } catch (err) {
    next(err);
  }
}

export async function me(req, res, next) {
  try {
    // Reload with safe academic references for the frontend
    const user = await User.findById(req.user._id).populate({
      path: 'section',
      select: 'name semester status',
      populate: [{ path: 'department', select: 'name code' }],
    });
    if (!user) throw new ApiError(401, 'Account no longer exists');
    const payload = publicUser(user);
    payload.section = publicSection(user.section);
    res.json({ success: true, user: payload });
  } catch (err) {
    next(err);
  }
}
