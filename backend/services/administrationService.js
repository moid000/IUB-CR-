import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import AdminProfile from '../models/AdminProfile.js';
import WipeVerification from '../models/WipeVerification.js';
import { ApiError } from '../middleware/error.js';
import { assertEmail } from '../utils/validators.js';
import { normalizeWhatsApp } from './teacherService.js';
import { sendOtpEmail } from './emailService.js';
import { sendText } from './whatsappService.js';
import { auditFromReq } from '../utils/audit.js';

/**
 * Administration profile + PROTECTED data deletion.
 *
 * Policy (owner-mandated, 2026-09-25): Tri3M data can NEVER be deleted by a
 * single action. The only deletion path (POST /api/admin/wipe-all) requires
 * TWO fresh verification codes — one emailed to the administration email and
 * one sent to the administration WhatsApp number stored in this profile.
 * Both codes must be presented together. Codes are single-use, expire in
 * 15 minutes, and are stored only as bcrypt hashes. This means no admin
 * session, no prompt to an AI agent, and no one else can wipe the data
 * unless the administration physically receives codes on BOTH channels.
 *
 * There is no longer any delete button in the admin panel UI.
 */

const PROFILE_KEY = 'administration';
const WIPE_CODE_TTL_MS = 15 * 60 * 1000;      // codes valid 15 minutes
const WIPE_RESEND_COOLDOWN_MS = 60 * 1000;   // 60s between code requests
const WIPE_MAX_REQUESTS_PER_HOUR = 3;        // max code requests per rolling hour
const WIPE_MAX_ATTEMPTS = 5;                 // wrong code attempts before the pair burns

function randomCode() {
  // Cryptographically secure 6-digit code, zero-padded (same primitive as OTPs)
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

function maskPhone(digits) {
  if (digits.length < 6) return '***';
  return `${'*'.repeat(Math.max(digits.length - 4, 1))}${digits.slice(-4)}`;
}

async function getProfileDoc() {
  return AdminProfile.findOne({ key: PROFILE_KEY });
}

/** Public (admin-only route) profile read. */
export async function getAdminProfile() {
  const profile = await getProfileDoc();
  if (!profile) {
    return { configured: false, profile: null };
  }
  return {
    configured: true,
    profile: {
      name: profile.name || '',
      email: profile.email,
      whatsapp: profile.whatsapp,
      updatedAt: profile.updatedAt,
    },
  };
}

/** Create/update the administration profile. */
export async function updateAdminProfile(req) {
  const { name, email, whatsapp } = req.body ?? {};
  const cleanEmail = assertEmail(email, 'email');
  const intl = normalizeWhatsApp(whatsapp);
  if (!intl) {
    throw new ApiError(400, 'WhatsApp number must be a valid international number (e.g. +92 301 2345678)');
  }
  const cleanName = String(name ?? '').trim().slice(0, 80);

  const profile = await AdminProfile.findOneAndUpdate(
    { key: PROFILE_KEY },
    { key: PROFILE_KEY, name: cleanName, email: cleanEmail, whatsapp: intl },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  await auditFromReq(req, {
    action: 'admin.profile-updated', entityType: 'administration', entityId: profile._id,
    after: { name: cleanName, email: cleanEmail, whatsapp: intl },
  });

  return { name: profile.name || '', email: profile.email, whatsapp: profile.whatsapp };
}

/**
 * Sends a fresh PAIR of wipe verification codes: email code → profile email,
 * WhatsApp code → profile WhatsApp. Codes are bcrypt-hashed before storage.
 * If EITHER channel fails, the whole pair is invalidated — a code the
 * administration never received can never verify.
 */
export async function requestWipeCodes(req) {
  const profile = await getProfileDoc();
  if (!profile) {
    throw new ApiError(400, 'Administration profile is not set up yet. Add your email and WhatsApp number first.');
  }

  // 60s cooldown between requests
  const cooldownSince = new Date(Date.now() - WIPE_RESEND_COOLDOWN_MS);
  const recent = await WipeVerification.findOne({ createdAt: { $gte: cooldownSince } }).sort({ createdAt: -1 });
  if (recent) {
    throw new ApiError(429, 'Please wait a minute before requesting new codes');
  }

  // Max 3 requests per rolling hour
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const lastHour = await WipeVerification.countDocuments({ createdAt: { $gte: hourAgo } });
  if (lastHour >= WIPE_MAX_REQUESTS_PER_HOUR) {
    throw new ApiError(429, 'Too many code requests. Please try again later.');
  }

  const emailCode = randomCode();
  const waCode = randomCode();
  const [emailCodeHash, waCodeHash] = await Promise.all([
    bcrypt.hash(emailCode, 10),
    bcrypt.hash(waCode, 10),
  ]);

  // Only the newest pair is valid — drop any previous pending pair.
  await WipeVerification.deleteMany({});
  const verification = await WipeVerification.create({
    emailCodeHash,
    waCodeHash,
    expiresAt: new Date(Date.now() + WIPE_CODE_TTL_MS),
  });

  try {
    await sendOtpEmail({
      to: profile.email,
      name: profile.name || 'Administration',
      otp: emailCode,
      purpose: 'wipe',
    });
    await sendText(profile.whatsapp, (
      'Tri3M — Data deletion verification\n\n' +
      `Your code is: *${waCode}*\n\n` +
      'This code authorizes the PERMANENT DELETION of all Tri3M data.\n' +
      'A separate code was emailed to the administration email — BOTH are required.\n' +
      'Codes expire in 15 minutes. If you did not request this, ignore this message.\n\n' +
      '— Tri3M Class Agent'
    ));
  } catch (err) {
    // A code pair that was not fully delivered must never verify.
    await WipeVerification.deleteOne({ _id: verification._id }).catch(() => {});
    throw err instanceof ApiError ? err : new ApiError(502, 'Could not deliver verification codes. Please try again.');
  }

  await auditFromReq(req, {
    action: 'admin.wipe-codes-requested', entityType: 'administration', entityId: profile._id,
    after: { email: profile.email, whatsapp: profile.whatsapp },
  });

  return {
    expiresInSeconds: WIPE_CODE_TTL_MS / 1000,
    sentTo: { email: maskEmail(profile.email), whatsapp: maskPhone(profile.whatsapp) },
  };
}

/**
 * Verifies BOTH codes against the latest pending pair and consumes the pair
 * (single use). Called by the wipe service BEFORE any deletion happens.
 * Plaintext codes are never stored or logged.
 */
export async function verifyAndConsumeWipeCodes({ emailCode, waCode }) {
  const email = String(emailCode ?? '').trim();
  const wa = String(waCode ?? '').trim();
  if (!email || !wa) {
    throw new ApiError(403, 'Data deletion requires the verification codes sent to the administration email AND WhatsApp number.');
  }

  const verification = await WipeVerification.findOne({}).sort({ createdAt: -1 });
  if (!verification) {
    throw new ApiError(403, 'No active verification codes. Request codes first.');
  }
  if (verification.expiresAt <= new Date()) {
    await WipeVerification.deleteOne({ _id: verification._id });
    throw new ApiError(403, 'Verification codes have expired. Request new codes.');
  }
  if (verification.attempts >= WIPE_MAX_ATTEMPTS) {
    await WipeVerification.deleteOne({ _id: verification._id });
    throw new ApiError(403, 'Too many wrong attempts. Request new codes.');
  }

  const [emailOk, waOk] = await Promise.all([
    bcrypt.compare(email, verification.emailCodeHash),
    bcrypt.compare(wa, verification.waCodeHash),
  ]);
  if (!emailOk || !waOk) {
    const attempts = verification.attempts + 1;
    if (attempts >= WIPE_MAX_ATTEMPTS) {
      await WipeVerification.deleteOne({ _id: verification._id });
    } else {
      await WipeVerification.updateOne({ _id: verification._id }, { $set: { attempts } });
    }
    throw new ApiError(403, 'Invalid verification codes.');
  }

  // Single use — the pair is consumed the instant it verifies.
  await WipeVerification.deleteOne({ _id: verification._id });
}
