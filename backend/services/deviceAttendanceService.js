/**
 * Hardware attendance — Phase 1 backend (docs/hardware-attendance-design.md).
 *
 * Device-facing endpoints (HMAC-signed, no user auth):
 *   POST /api/device/heartbeat  — liveness + enrollment-mode poll
 *   POST /api/device/scan        — THE ingestion path (fingerprintId -> record)
 *   POST /api/device/enroll      — CR-PIN-guided template binding
 *
 * CR-facing management (cookie auth, section-scoped):
 *   register / list / rotate-secret / revoke / start-enrollment
 *
 * SECURITY CONTRACT (design §4.3):
 * - Signature: HMAC_SHA256(key = sha256(deviceSecret), deviceId|ts|nonce|body)
 *   The RAW secret is never stored server-side; the firmware derives the key
 *   with the same one-way hash at boot (design §3).
 * - |now - ts| <= 90s on EVERY device request (replay window). Offline-synced
 *   scans carry `occurredAt` in the signed body — the send timestamp is still
 *   now, the session resolution uses occurredAt (<= 6h old).
 * - scanId idempotency: DeviceScanEvent unique index; a redelivery replays the
 *   STORED result — attendance can never be double-marked.
 * - A device is bound to ONE section; bindings and sessions are section-
 *   scoped, a 3M fingerprint can never mark attendance in another section.
 * - Attendance records are append-only (existing rule): device marks use
 *   method 'device' and one-record-per-session-per-student is DB-guaranteed.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { ApiError } from '../middleware/error.js';
import { audit } from '../utils/audit.js';
import { now, karachiWallClock } from '../utils/clock.js';

const {
  Section, Subject, Timetable, User, AttendanceSession, AttendanceRecord,
  AttendanceDevice, FingerprintBinding, DeviceScanEvent,
} = await import('../models/index.js');

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const sha256hex = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

/** Timing-safe hex compare — a signature mismatch never leaks via timing. */
function constantTimeEqualsHex(a, b) {
  const A = Buffer.from(String(a ?? ''), 'utf8');
  const B = Buffer.from(String(b ?? ''), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const hmacSign = (key, payload) =>
  crypto.createHmac('sha256', String(key)).update(String(payload), 'utf8').digest('hex');

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Verifies a signed device request. Returns the device doc. Never trusts
 * client claims — secret, status and section all come from the DB. */
async function verifySignedDevice(req) {
  const deviceId = String(req.headers['x-device-id'] ?? '').trim();
  const ts = Number(req.headers['x-timestamp']);
  const nonce = String(req.headers['x-scan-id'] ?? '').trim();
  const signature = String(req.headers['x-signature'] ?? '').trim();
  if (!deviceId || !nonce || !signature || !Number.isFinite(ts)) {
    throw new ApiError(401, 'Missing device headers');
  }
  const device = await AttendanceDevice.findOne({ deviceId }).select('+secretHash').lean();
  if (!device) throw new ApiError(401, 'Unknown device');
  if (device.status !== 'active') throw new ApiError(403, 'Device revoked');

  // replay window on the SEND timestamp (every request, incl. offline sync)
  const tNow = now();
  if (Math.abs(tNow - ts) > 90_000) throw new ApiError(401, 'Stale timestamp');

  // canonical signed string: fixed field order, no raw-body parsing needed
  const body = req.body ?? {};
  const payload = [deviceId, ts, nonce, JSON.stringify(body ?? {})].join('|');
  const expected = hmacSign(device.secretHash, payload);
  if (!constantTimeEqualsHex(signature, expected)) {
    await audit({ actor: null, actorRole: 'system', action: 'device.auth.bad-signature',
      section: device.section, after: { deviceId } });
    throw new ApiError(401, 'Bad signature');
  }
  return device;
}

/** The section's CR user (or GR fallback) — device-opened sessions need a
 * human `createdBy` (AttendanceSession contract); the device itself never
 * gets a User identity. */
async function sectionRepresentative(sectionId) {
  const section = await Section.findById(sectionId).lean();
  if (section?.cr) {
    const cr = await User.findById(section.cr).lean();
    if (cr) return cr;
  }
  const gr = await User.findOne({ section: sectionId, role: 'gr' }).lean();
  if (gr) return gr;
  return null;
}

/**
 * Session resolution at an instant (design §4.3):
 *   1. an OPEN device session for the section covering that instant -> reuse
 *   2. a timetable slot covering [start-10min, end) -> auto-open a device
 *      session for that subject (codeHash = hash of a random UUID nobody sees)
 *   3. nothing -> null (the device is not a general-purpose kiosk)
 */
async function resolveSession(sectionId, atMs) {
  const open = await AttendanceSession.findOne({
    section: sectionId, source: 'device', status: 'open',
    opensAt: { $lte: new Date(atMs) }, expiresAt: { $gt: new Date(atMs) },
  }).lean();
  if (open) return open;

  const { dateStr: dayStr, minutes } = karachiWallClock(atMs);
  const slots = await Timetable.find({ section: sectionId, date: dayStr }).lean();
  for (const slot of slots) {
    const start = minutesOf(slot.startTime);
    const end = minutesOf(slot.endTime);
    if (start === null || end === null || end <= start) continue;
    if (minutes >= start - 10 && minutes < end) {
      const rep = await sectionRepresentative(sectionId);
      if (!rep) return { __error: 'no_representative' };
      const session = await AttendanceSession.create({
        section: sectionId, subject: slot.subject, createdBy: rep._id,
        date: new Date(atMs),
        opensAt: new Date(atMs - (minutes - (start - 10)) * 60_000),
        expiresAt: new Date(atMs + (end - minutes) * 60_000),
        codeHash: sha256hex(crypto.randomUUID()), // unguessable, never revealed
        status: 'open', source: 'device',
      });
      await audit({ actor: rep._id, actorRole: 'system',
        action: 'attendance.device.session-opened', entityType: 'attendance_session',
        entityId: session._id, section: sectionId,
        after: { subject: String(slot.subject), auto: true } });
      return session;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* CR-facing management (cookie auth at the route layer)                */
/* ------------------------------------------------------------------ */

export async function registerDevice(req) {
  if (!req.user?.section) throw new ApiError(400, 'You are not assigned to a section');
  const label = String(req.body?.label ?? 'Door device').trim().slice(0, 60) || 'Door device';
  const deviceId = `dev_${crypto.randomBytes(6).toString('hex')}`;
  const secret = crypto.randomBytes(32).toString('hex'); // 64 hex chars, shown ONCE
  const secretHash = sha256hex(secret); // = the HMAC key the firmware derives
  const device = await AttendanceDevice.create({
    section: req.user.section, label, deviceId, secretHash,
    secretLast4: secret.slice(-4), createdBy: req.user._id,
  });
  await audit({ actor: req.user._id, actorRole: req.user.role,
    action: 'attendance.device.registered', entityType: 'attendance_device',
    entityId: device._id, section: req.user.section, after: { deviceId, label } });
  return { deviceId, secret, label }; // secret returned ONCE, never again
}

export async function listDevices(req) {
  if (!req.user?.section) throw new ApiError(400, 'You are not assigned to a section');
  const devices = await AttendanceDevice.find({ section: req.user.section })
    .select('-__v -secretHash -enrollmentPinHash').lean();
  return { items: devices, pagination: null }; // wrapList envelope
}

export async function rotateSecret(req) {
  if (!req.user?.section) throw new ApiError(400, 'You are not assigned to a section');
  const device = await AttendanceDevice.findOne({ _id: req.params.id, section: req.user.section })
    .select('+secretHash');
  if (!device) throw new ApiError(404, 'Device not found');
  const secret = crypto.randomBytes(32).toString('hex');
  device.secretHash = sha256hex(secret);
  device.secretLast4 = secret.slice(-4);
  await device.save();
  await audit({ actor: req.user._id, actorRole: req.user.role,
    action: 'attendance.device.secret-rotated', entityType: 'attendance_device',
    entityId: device._id, section: req.user.section, after: { deviceId: device.deviceId } });
  return { deviceId: device.deviceId, secret }; // shown ONCE
}

export async function revokeDevice(req) {
  if (!req.user?.section) throw new ApiError(400, 'You are not assigned to a section');
  const device = await AttendanceDevice.findOne({ _id: req.params.id, section: req.user.section });
  if (!device) throw new ApiError(404, 'Device not found');
  if (device.status !== 'revoked') {
    device.status = 'revoked';
    device.enrollmentMode = 'off';
    await device.save();
  }
  await audit({ actor: req.user._id, actorRole: req.user.role,
    action: 'attendance.device.revoked', entityType: 'attendance_device',
    entityId: device._id, section: req.user.section, after: { deviceId: device.deviceId } });
  return { deviceId: device.deviceId, status: 'revoked' };
}

/** CR picks the student -> 4-digit PIN (10 min) -> student types it at the
 * device with their finger. The PIN proves the CR authorized THIS identity. */
export async function startEnrollment(req) {
  if (!req.user?.section) throw new ApiError(400, 'You are not assigned to a section');
  const device = await AttendanceDevice.findOne({ _id: req.params.id, section: req.user.section });
  if (!device) throw new ApiError(404, 'Device not found');
  if (device.status !== 'active') throw new ApiError(400, 'Device is revoked');

  const studentId = String(req.body?.studentId ?? '').trim();
  const student = await User.findOne({ _id: studentId, section: req.user.section, role: 'student' }).lean();
  if (!student) throw new ApiError(404, 'Student not found in your section');

  const pin = String(crypto.randomInt(1000, 10000));
  device.enrollmentMode = 'on';
  device.enrollmentPinHash = await bcrypt.hash(pin, 10);
  device.enrollmentPinExpiresAt = new Date(now() + 10 * 60_000);
  device.enrollmentUserId = student._id;
  device.enrollmentStartedBy = req.user._id;
  await device.save();
  await audit({ actor: req.user._id, actorRole: req.user.role,
    action: 'attendance.device.enrollment-started', entityType: 'attendance_device',
    entityId: device._id, section: req.user.section,
    targetUser: student._id, after: { deviceId: device.deviceId } });
  return { pin, student: { _id: student._id, name: student.name } }; // PIN shown ONCE
}

/* ------------------------------------------------------------------ */
/* Device-facing (HMAC)                                                 */
/* ------------------------------------------------------------------ */

export async function deviceHeartbeat(req) {
  const device = await verifySignedDevice(req);
  await AttendanceDevice.updateOne(
    { _id: device._id },
    { $set: { lastSeenAt: new Date(now()),
      fwVersion: String(req.body?.fwVersion ?? '').slice(0, 20) || undefined } }
  );
  return { ok: true, enrollmentMode: device.enrollmentMode };
}

/** THE ingestion endpoint. Idempotent by scanId; replies are replayed
 * verbatim on redelivery so the device shows the same outcome twice. */
export async function deviceScan(req) {
  const device = await verifySignedDevice(req);
  const fingerprintId = Number(req.body?.fingerprintId);
  const scanId = String(req.body?.scanId ?? req.headers['x-scan-id'] ?? '').trim().slice(0, 64);
  if (!scanId) throw new ApiError(400, 'Missing scanId');
  if (!Number.isInteger(fingerprintId) || fingerprintId < 1 || fingerprintId > 192) {
    throw new ApiError(400, 'Invalid fingerprintId');
  }
  const tNow = now();
  // occurredAt (ms epoch): device clock of the actual touch. Absent = now.
  // Offline sync may deliver old scans — allowed up to 6h; future > 2min is
  // a broken clock and is rejected rather than silently re-dated.
  let occurredAt = Number(req.body?.occurredAt);
  if (!Number.isFinite(occurredAt)) occurredAt = tNow;
  if (occurredAt > tNow + 2 * 60_000) {
    return { ok: false, result: 'rejected', reason: 'future_clock' };
  }
  if (tNow - occurredAt > 6 * 3600_000) {
    return { ok: false, result: 'rejected', reason: 'too_old' };
  }

  // idempotency claim — a redelivery replays the STORED result
  const existing = await DeviceScanEvent.findOne({ scanId }).lean();
  if (existing && existing.result !== 'pending') {
    return {
      ok: existing.result === 'marked' || existing.result === 'duplicate',
      result: existing.result, reason: existing.reason ?? undefined,
      replay: true, session: existing.session ? { _id: existing.session } : undefined,
    };
  }
  const event = existing ?? (await DeviceScanEvent.create({
    deviceId: device._id, scanId, fingerprintId,
    occurredAt: new Date(occurredAt), result: 'pending',
  }).catch((err) => {
    if (err?.code === 11000) return null; // concurrent claim — treat as replay
    throw err;
  }));
  if (!event) {
    const raced = await DeviceScanEvent.findOne({ scanId }).lean();
    return { ok: raced?.result === 'marked', result: raced?.result ?? 'pending', replay: true };
  }

  const finish = async (result, extra = {}) => {
    await DeviceScanEvent.updateOne(
      { _id: event._id },
      { $set: { result, reason: extra.reason ?? null, session: extra.sessionId ?? null,
        student: extra.studentId ?? null } }
    );
    return { ok: result === 'marked' || result === 'duplicate', result, ...extra };
  };

  // identity resolution — binding must be ACTIVE and section-scoped
  const binding = await FingerprintBinding.findOne({
    deviceId: device._id, fingerprintId, status: 'active',
  }).lean();
  if (!binding || String(binding.section) !== String(device.section)) {
    return finish('rejected', { reason: 'not_enrolled' });
  }
  const student = await User.findById(binding.user).lean();
  if (!student || student.registrationStatus === 'suspended'
    || String(student.section) !== String(device.section)) {
    return finish('rejected', { reason: 'not_enrolled' });
  }

  // session resolution at the touch time
  const session = await resolveSession(device.section, occurredAt);
  if (!session) return finish('no_class');
  if (session.__error) return finish('rejected', { reason: session.__error });

  const subject = await Subject.findById(session.subject).lean();

  try {
    await AttendanceRecord.create({
      session: session._id, student: student._id, section: device.section,
      markedAt: new Date(occurredAt), method: 'device', status: 'present',
      ip: req.ip ?? null, userAgent: 'attendance-device',
    });
  } catch (err) {
    if (err?.code === 11000) {
      // one record per session+student — a second touch is a duplicate, not
      // an error: the device shows "already" and attendance stays single.
      return finish('duplicate', {
        already: true, name: student.name.split(' ')[0],
        sessionId: session._id, studentId: student._id,
        session: { _id: session._id, subject: subject?.name ?? null },
      });
    }
    throw err;
  }
  await AttendanceDevice.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date(tNow) } });
  return finish('marked', {
    name: student.name.split(' ')[0], // FIRST NAME only on the OLED (privacy)
    sessionId: session._id, studentId: student._id,
    session: { _id: session._id, subject: subject?.name ?? null },
  });
}

/** Enrollment capture: sensor slot N + the CR's PIN -> binding created. */
export async function deviceEnroll(req) {
  const device = await verifySignedDevice(req);
  if (device.enrollmentMode !== 'on') {
    return { ok: false, reason: 'not_enrolling' };
  }
  const fingerprintId = Number(req.body?.fingerprintId);
  const pin = String(req.body?.pin ?? '').trim();
  if (!Number.isInteger(fingerprintId) || fingerprintId < 1 || fingerprintId > 192) {
    throw new ApiError(400, 'Invalid fingerprintId');
  }
  if (!/^\d{4}$/.test(pin)) return { ok: false, reason: 'bad_pin' };
  const tNow = now();
  if (!device.enrollmentPinExpiresAt || tNow > new Date(device.enrollmentPinExpiresAt).getTime()) {
    return { ok: false, reason: 'pin_expired' };
  }
  const pinOk = await bcrypt.compare(pin, device.enrollmentPinHash ?? '');
  if (!pinOk) {
    await audit({ actor: null, actorRole: 'system', action: 'device.enroll.bad-pin',
      section: device.section, after: { deviceId: device.deviceId } });
    return { ok: false, reason: 'bad_pin' };
  }
  const student = await User.findById(device.enrollmentUserId).lean();
  if (!student || String(student.section) !== String(device.section)) {
    return { ok: false, reason: 'not_enrolling' };
  }

  // append-only: revoke any old ACTIVE binding for this student or this
  // sensor slot first, then create the new one.
  await FingerprintBinding.updateMany(
    { deviceId: device._id, status: 'active', $or: [{ user: student._id }, { fingerprintId }] },
    { $set: { status: 'revoked', revokedAt: new Date(tNow), revocationReason: 're-enrolled' } }
  );
  await FingerprintBinding.create({
    section: device.section, user: student._id, deviceId: device._id,
    fingerprintId, enrolledBy: device.enrollmentStartedBy, status: 'active',
  });
  await AttendanceDevice.updateOne({ _id: device._id }, {
    $set: { enrollmentMode: 'off', enrollmentPinHash: null,
      enrollmentPinExpiresAt: null, enrollmentUserId: null, enrollmentStartedBy: null },
    $inc: { enrolledCount: 1 },
    lastSeenAt: new Date(tNow),
  });
  await audit({ actor: device.enrollmentStartedBy, actorRole: 'cr',
    action: 'attendance.device.enrolled', entityType: 'attendance_device',
    entityId: device._id, section: device.section, targetUser: student._id,
    after: { deviceId: device.deviceId, fingerprintId } });
  return { ok: true, name: student.name.split(' ')[0] };
}
