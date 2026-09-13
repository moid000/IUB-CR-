import AuditLog from '../models/AuditLog.js';

// Keys that must NEVER be persisted in audit before/after snapshots.
const SENSITIVE_KEYS = new Set(['password', 'code', 'codehash', 'token', 'secret', 'otps']);

function sanitize(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) continue;
    out[key] = sanitize(val);
  }
  return out;
}

/**
 * Server-side audit logging. Never exposed to clients; there are no
 * update/delete routes for audit logs (append-only by design).
 *
 * - `actor` must be a server-derived User id (or null for the system actor).
 * - `email` stores only the NORMALIZED email for auth events (throttle +
 *   investigation) — never passwords, never tokens.
 * - Callers must never pass client-supplied actor identities.
 */
export async function audit({
  actor = null,
  actorRole = 'system',
  action,
  entityType,
  entityId,
  email,
  section = null,
  targetUser = null,
  before,
  after,
  reason,
  ip,
  userAgent,
}) {
  try {
    await AuditLog.create({
      actor,
      actorRole,
      action,
      entityType,
      entityId,
      email: email ? String(email).toLowerCase() : undefined,
      section,
      targetUser,
      before: sanitize(before),
      after: sanitize(after),
      reason,
      ip,
      userAgent,
    });
  } catch (err) {
    // Audit failures must never break the request; log the action name only.
    console.error('[audit] write failed:', action, err.message);
  }
}

/** Derives actor/ip/userAgent from an authenticated request. */
export function auditFromReq(req, data) {
  return audit({
    actor: req.user?._id ?? null,
    actorRole: req.user?.role ?? 'system',
    ip: req.ip,
    userAgent: req.get('user-agent'),
    ...data,
  });
}
