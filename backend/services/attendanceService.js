import crypto from 'node:crypto';
import { AttendanceSession, AttendanceRecord, Section, Subject } from '../models/index.js';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import * as v from '../utils/validators.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import { now, nowDate } from '../utils/clock.js';

/**
 * Attendance (Step 8).
 *
 * Flow: CR starts a session for THEIR section → server generates a crypto-
 * random 8-char Crockford Base32 code → only SHA-256(code) is stored →
 * plaintext code + signed QR payload are returned to the CR EXACTLY ONCE.
 * Students mark attendance with the code or the signed QR while the session
 * is open (10-minute window, server UTC). 10 failed code attempts auto-cancel
 * the session. One AttendanceRecord per session+student (unique index).
 *
 * ATTENDANCE_SECRET is dedicated to QR signing — never JWT_SECRET, never
 * logged, never returned, and attendance signing FAILS SAFELY if unset.
 */

const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FAILED_ATTEMPTS = 10;
// Crockford Base32 — excludes I, L, O, U (ambiguous/offensive)
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-Z]{8}$/;

/* ---------------------------- secret + crypto ---------------------------- */

function assertAttendanceSecret() {
  // fail SAFE — never silently fall back to another secret
  if (!env.attendanceSecret) {
    throw new ApiError(503, 'Attendance signing is not configured');
  }
  return env.attendanceSecret;
}

/** crypto.randomBytes only — Math.random is forbidden here. */
export function generateCode() {
  const bytes = crypto.randomBytes(8); // 256 % 32 === 0 → uniform draw
  let code = '';
  for (let i = 0; i < 8; i += 1) code += CROCKFORD[bytes[i] % 32];
  return code;
}

const sha256 = (value) =>
  crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

function constantTimeEqualsHex(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* -------------------------------- QR ------------------------------------ */

/**
 * Signed QR token: base64url(JSON payload) + '.' + base64url(HMAC-SHA256).
 * Payload contains ONLY { sid, code, exp } — no user information whatsoever.
 * Deterministic serialization (fixed key order constructed here).
 */
export function signQrPayload(session, code) {
  const secret = assertAttendanceSecret();
  const payload = { sid: String(session._id), code, exp: session.expiresAt.getTime() };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyQrPayload(token) {
  const secret = assertAttendanceSecret();
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2) throw new ApiError(400, 'Invalid attendance code');
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new ApiError(400, 'Invalid attendance code');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError(400, 'Invalid attendance code');
  }
  if (
    typeof payload !== 'object' || payload === null ||
    typeof payload.sid !== 'string' || !v.isValidObjectId(payload.sid) ||
    typeof payload.code !== 'string' || typeof payload.exp !== 'number'
  ) {
    throw new ApiError(400, 'Invalid attendance code');
  }
  return payload;
}

/* ------------------------------ response ------------------------------ */

function safeSession(doc, extra = {}) {
  return {
    _id: doc._id,
    section: doc.section,
    subject: doc.subject,
    date: doc.date,
    opensAt: doc.opensAt,
    expiresAt: doc.expiresAt,
    status: doc.status,
    failedAttempts: doc.failedAttempts ?? 0,
    attendanceCount: extra.attendanceCount,
  };
}

/* --------------------------- session creation --------------------------- */

async function assertSectionSubject(subjectId, sectionId) {
  const id = v.assertObjectId(subjectId, 'subject id');
  const subject = await Subject.findById(id);
  if (!subject) throw new ApiError(400, 'Subject not found');
  if (String(subject.section) !== String(sectionId)) {
    throw new ApiError(400, 'Subject does not belong to this section');
  }
  if (subject.status !== 'active') throw new ApiError(400, 'Subject is archived');
  return id;
}

export async function createSession(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  assertAttendanceSecret(); // fail fast before generating anything

  const section = await Section.findById(req.user.section);
  if (!section) throw new ApiError(400, 'Section not found');
  if (section.status !== 'active') throw new ApiError(400, 'Section is archived');

  const body = v.pick(req.body, ['subject']); // section/code/codeHash/status/expiresAt never read
  const subject = await assertSectionSubject(body.subject, section._id);

  const code = generateCode();
  const session = await AttendanceSession.create({
    section: section._id,
    subject,
    createdBy: req.user._id, // server-derived
    date: nowDate(),
    opensAt: nowDate(),
    expiresAt: new Date(now() + WINDOW_MS), // server-controlled — never client input
    codeHash: sha256(code), // plaintext code is NEVER stored anywhere
    failedAttempts: 0,
    status: 'open',
  });

  await auditFromReq(req, {
    action: 'attendance.session.create',
    entityType: 'attendance_session',
    entityId: session._id,
    section: session.section,
    after: { subject: String(subject), expiresAt: session.expiresAt.toISOString() }, // no code, no hash
  });

  // Plaintext code + signed QR returned EXACTLY ONCE, only to the creating CR.
  return { session: safeSession(session, { attendanceCount: 0 }), code, qr: signQrPayload(session, code) };
}

/* ------------------------------- CR views ------------------------------- */

function sessionFilters(query, { forceSection }) {
  const filter = {};
  if (forceSection) filter.section = forceSection;
  const sectionParam = query.sectionId ?? query.section;
  if (sectionParam) filter.section = v.assertObjectId(sectionParam, 'section id');
  if (query.subjectId) filter.subject = v.assertObjectId(query.subjectId, 'subject id');
  if (query.status) filter.status = v.assertEnum(query.status, ['open', 'cancelled'], 'status');
  return filter;
}

async function listSessions(filter, query) {
  const { page, limit, skip } = parsePagination(query);
  const [items, total] = await Promise.all([
    AttendanceSession.find(filter).populate('subject', 'name code')
      .sort({ opensAt: -1, _id: -1 }).skip(skip).limit(limit),
    AttendanceSession.countDocuments(filter),
  ]);
  const counts = await Promise.all(items.map((s) =>
    AttendanceRecord.countDocuments({ session: s._id, status: 'present' })));
  return {
    items: items.map((s, i) => safeSession(s, { attendanceCount: counts[i] })),
    pagination: paginationMeta(total, { page, limit }),
  };
}

export async function listSessionsCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  return listSessions(
    sessionFilters({ ...req.query, sectionId: undefined, section: undefined },
      { forceSection: req.user.section }),
    req.query
  );
}

export async function listSessionsAdmin(req) {
  return listSessions(sessionFilters(req.query, {}), req.query);
}

async function findOwnSession(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const id = v.assertObjectId(req.params.id, 'session id');
  const session = await AttendanceSession.findOne({ _id: id, section: req.user.section })
    .populate('subject', 'name code');
  if (!session) throw new ApiError(404, 'Attendance session not found'); // cross-section = missing
  return session;
}

export async function getSessionCr(req) {
  const session = await findOwnSession(req);
  const attendanceCount = await AttendanceRecord.countDocuments({
    session: session._id, status: 'present',
  });
  return safeSession(session, { attendanceCount });
}

export async function getSessionAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'session id');
  const session = await AttendanceSession.findById(id).populate('subject', 'name code');
  if (!session) throw new ApiError(404, 'Attendance session not found');
  const attendanceCount = await AttendanceRecord.countDocuments({
    session: session._id, status: 'present',
  });
  return safeSession(session, { attendanceCount });
}

/** Students see ACTIVE sessions of their OWN section only — never the code,
 *  codeHash or QR payload. Discovering the session id is required by the
 *  manual `POST /attendance/sessions/:sessionId/attend` route; the code
 *  itself still comes from the CR in class. */
export async function listSessionsStudent(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const nowD = nowDate();
  const items = await AttendanceSession.find({
    section: req.user.section,
    status: 'open',
    opensAt: { $lte: nowD }, // future-scheduled sessions are invisible to students
    expiresAt: { $gt: nowD },
  }).populate('subject', 'name code').sort({ opensAt: -1 }).limit(10);
  return {
    items: items.map((s) => safeSession(s, {})),
    pagination: paginationMeta(items.length, { page: 1, limit: 10 }),
  };
}

/* ------------------------------- cancel -------------------------------- */

export async function cancelSession(req) {
  const session = await findOwnSession(req);
  if (session.status === 'cancelled') throw new ApiError(409, 'Session already cancelled');
  // atomic open→cancelled flip (idempotent under races)
  const updated = await AttendanceSession.findOneAndUpdate(
    { _id: session._id, status: 'open' },
    { $set: { status: 'cancelled' } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'Session already cancelled');
  await auditFromReq(req, {
    action: 'attendance.session.cancel',
    entityType: 'attendance_session', entityId: session._id, section: session.section,
    before: { status: 'open' }, after: { status: 'cancelled' },
  });
  const attendanceCount = await AttendanceRecord.countDocuments({ session: session._id, status: 'present' });
  return safeSession(updated, { attendanceCount });
}

/* --------------------------- attendance marking -------------------------- */

/**
 * SHARED verification core for manual code and QR — there is exactly ONE
 * attendance path; the QR endpoint only decodes + signature-checks before
 * handing (sessionId, code) to this function.
 */
async function markAttendance(req, sessionId, rawCode, { via }) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const id = v.assertObjectId(sessionId, 'session id');

  // Cross-section sessions are indistinguishable from missing ones.
  const session = await AttendanceSession.findOne({ _id: id, section: req.user.section })
    .select('+codeHash');
  if (!session) throw new ApiError(404, 'Attendance session not found');

  // Server-side state — never client-supplied status/expiry.
  if (session.status !== 'open' || now() >= session.expiresAt.getTime()) {
    await auditFromReq(req, {
      action: via === 'qr' ? 'attendance.qr.failed' : 'attendance.attend.failed',
      entityType: 'attendance_session', entityId: session._id, section: session.section,
      targetUser: req.user._id, reason: 'session-inactive', // never the code or hash
    });
    throw new ApiError(400, 'Session is no longer active');
  }

  // Normalize + format-check (never counts as a guess — it can never match).
  const code = String(rawCode ?? '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new ApiError(400, 'Invalid attendance code');

  // Hash compare — timing-safe, plaintext never stored anywhere.
  if (!constantTimeEqualsHex(sha256(code), session.codeHash)) {
    // Atomic increment — concurrent wrong codes can never bypass the limit.
    const updated = await AttendanceSession.findOneAndUpdate(
      { _id: session._id, status: 'open' },
      { $inc: { failedAttempts: 1 } },
      { new: true, select: 'failedAttempts status' }
    );
    if (updated && updated.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      await AttendanceSession.updateOne(
        { _id: session._id, status: 'open' },
        { $set: { status: 'cancelled' } }
      );
    }
    await auditFromReq(req, {
      action: via === 'qr' ? 'attendance.qr.failed' : 'attendance.attend.failed',
      entityType: 'attendance_session', entityId: session._id, section: session.section,
      targetUser: req.user._id, reason: 'invalid-code', // never the code or hash
    });
    throw new ApiError(400, 'Invalid attendance code');
  }

  // One record per session+student — pre-check + E11000-safe create.
  const existing = await AttendanceRecord.exists({ session: session._id, student: req.user._id });
  if (existing) {
    await auditFromReq(req, {
      action: 'attendance.duplicate',
      entityType: 'attendance_session', entityId: session._id, section: session.section,
      targetUser: req.user._id,
    });
    throw new ApiError(409, 'Attendance already marked for this session');
  }

  try {
    const record = await AttendanceRecord.create({
      session: session._id,
      student: req.user._id, // server-derived — never client input
      section: session.section, // matches the session's section
      markedAt: nowDate(),
      ip: req.ip ?? null, // audit signal only — NOT proof of location/identity
      userAgent: req.get?.('user-agent')?.slice(0, 200) ?? null,
      method: 'self',
      status: 'present',
    });
    await auditFromReq(req, {
      action: via === 'qr' ? 'attendance.qr.success' : 'attendance.attend.success',
      entityType: 'attendance_session', entityId: session._id, section: session.section,
      targetUser: req.user._id, after: { record: String(record._id) },
    });
    return {
      _id: record._id,
      session: { _id: session._id, subject: session.subject, date: session.date, expiresAt: session.expiresAt },
      markedAt: record.markedAt,
      method: record.method,
      status: record.status,
    };
  } catch (err) {
    if (err?.code === 11000) { // concurrent duplicate race → exactly one record survives
      await auditFromReq(req, {
        action: 'attendance.duplicate',
        entityType: 'attendance_session', entityId: session._id, section: session.section,
        targetUser: req.user._id,
      });
      throw new ApiError(409, 'Attendance already marked for this session');
    }
    throw err;
  }
}

export function attendWithCode(req) {
  const body = v.pick(req.body, ['code']); // student/section/status/role never read
  return markAttendance(req, req.params.sessionId, body.code, { via: 'code' });
}

export function attendWithQr(req) {
  const body = v.pick(req.body, ['qr']);
  const payload = verifyQrPayload(body.qr); // signature first — never trust unsigned fields
  // The QR's own exp is checked, AND the session's server-side window applies.
  if (now() >= payload.exp) throw new ApiError(400, 'Session is no longer active');
  return markAttendance(req, payload.sid, payload.code, { via: 'qr' });
}

/* ------------------------------ record views ---------------------------- */

export async function listRecordsCr(req) {
  const session = await findOwnSession(req); // 404 for other sections
  return listRecords({ session: session._id }, req.query, { bySection: true });
}

export async function listRecordsAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'session id');
  const session = await AttendanceSession.findById(id);
  if (!session) throw new ApiError(404, 'Attendance session not found');
  return listRecords({ session: id }, req.query, { bySection: true });
}

async function listRecords(filter, query) {
  const { page, limit, skip } = parsePagination(query);
  const [items, total] = await Promise.all([
    AttendanceRecord.find(filter).populate('student', 'name rollNo email')
      .sort({ markedAt: -1, _id: -1 }).skip(skip).limit(limit),
    AttendanceRecord.countDocuments(filter),
  ]);
  return {
    items: items.map((r) => ({
      _id: r._id,
      session: r.session,
      student: r.student ? { _id: r.student._id, name: r.student.name, rollNo: r.student.rollNo } : null,
      markedAt: r.markedAt,
      method: r.method,
      status: r.status,
    })),
    pagination: paginationMeta(total, { page, limit }),
  };
}

/* --------------------------- student history ---------------------------- */

export async function listMyAttendance(req) {
  const { page, limit, skip } = parsePagination(req.query);
  // ownership is ALWAYS req.user._id — a client studentId is never read
  const filter = { student: req.user._id };
  if (req.query.subjectId) {
    const subject = v.assertObjectId(req.query.subjectId, 'subject id');
    const sessions = await AttendanceSession.find({ subject }, '_id');
    filter.session = { $in: sessions.map((s) => s._id) };
  }
  if (req.query.from || req.query.to) {
    filter.markedAt = {};
    if (req.query.from) filter.markedAt.$gte = v.assertDate(req.query.from, 'from');
    if (req.query.to) filter.markedAt.$lte = v.assertDate(req.query.to, 'to');
  }
  const [items, total] = await Promise.all([
    AttendanceRecord.find(filter)
      .populate({ path: 'session', select: 'subject date status', populate: { path: 'subject', select: 'name code' } })
      .sort({ markedAt: -1, _id: -1 }).skip(skip).limit(limit),
    AttendanceRecord.countDocuments(filter),
  ]);
  return {
    items: items.map((r) => ({
      _id: r._id,
      session: r.session ? {
        _id: r.session._id,
        subject: r.session.subject,
        date: r.session.date,
        status: r.session.status,
      } : null,
      markedAt: r.markedAt,
      method: r.method,
      status: r.status,
    })),
    pagination: paginationMeta(total, { page, limit }),
  };
}
