import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { env } from '../config/env.js';
import { normalizeEmail } from '../utils/validators.js';
import { audit } from '../utils/audit.js';

/**
 * Idempotent, fail-safe Admin bootstrap.
 *
 * - Credentials come ONLY from environment variables (ADMIN_EMAIL / ADMIN_PASSWORD).
 * - Password is hashed with bcrypt BEFORE saving — never stored or logged plaintext.
 * - If an admin already exists with ADMIN_EMAIL: no duplicate, no password reset,
 *   no overwrite of any account data.
 * - If ADMIN_EMAIL belongs to a NON-admin account: clear configuration error,
 *   the account is NEVER silently converted.
 *
 * `raw` performs the actual work (used directly by tests with overrides);
 * `ensureAdminBootstrap` caches the run once per serverless instance.
 */
async function raw(overrides = {}) {
  const email = normalizeEmail(overrides.email ?? env.adminEmail);
  const password = overrides.password ?? env.adminPassword;

  if (!email || !password) {
    console.warn('[bootstrap] ADMIN_EMAIL / ADMIN_PASSWORD not set — admin bootstrap skipped');
    return { skipped: true };
  }

  const existing = await User.findOne({ email });
  if (existing) {
    if (existing.role !== 'admin') {
      // FAIL SAFELY — never convert an existing non-admin account.
      throw new Error(
        `Admin bootstrap conflict: ADMIN_EMAIL (${email}) belongs to an existing ` +
          `${existing.role} account. Set ADMIN_EMAIL to a dedicated admin address.`
      );
    }
    return { existed: true }; // idempotent — password NOT reset, data untouched
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await User.create({
    name: 'Administrator',
    email,
    password: passwordHash,
    role: 'admin',
    registrationStatus: 'active',
    emailVerified: true,
    section: null,
    createdBy: null,
  });
  await audit({
    actorRole: 'system',
    action: 'admin.bootstrap',
    entityType: 'user',
    entityId: admin._id,
    email,
    after: { email, role: 'admin', registrationStatus: 'active' },
  });
  console.log('[bootstrap] admin account ensured for', email);
  return { created: true };
}

export async function ensureAdminBootstrap(overrides) {
  if (!overrides && globalThis.__adminBootstrap) return globalThis.__adminBootstrap;
  const run = raw(overrides);
  if (!overrides) globalThis.__adminBootstrap = run;
  try {
    return await run;
  } catch (err) {
    if (!overrides) globalThis.__adminBootstrap = null; // retry next invocation
    throw err;
  }
}

// Exposed for tests (bypasses the cache)
export { raw as runAdminBootstrap };
