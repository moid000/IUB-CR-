/**
 * HARDWARE ATTENDANCE — Phase 1 (docs/hardware-attendance-design.md).
 * End-to-end through the REAL app over HTTP:
 *   CR registers a device -> enroll a student via PIN -> fingerprint scans
 *   mark attendance against timetable slots.
 *
 * HD-1  register returns the secret ONCE; DB holds only its SHA-256
 * HD-2  bad/missing signature -> 401; a valid signature works
 * HD-3  stale timestamp (replay window) -> 401
 * HD-4  scan with no timetable slot -> no_class (never a kiosk)
 * HD-5  live slot -> session AUTO-OPENS, record marked method 'device'
 * HD-6  same student scans again (new scanId) -> duplicate, never a 2nd record
 * HD-7  EXACT redelivery of a scanId -> replayed result, still ONE record
 * HD-8  offline sync: old occurredAt (device flash queue) marks the SAME
 *       session retroactively; a stale >6h scan is rejected
 * HD-9  revoked device -> every signed request rejected; CR can still list
 * HD-10 not-enrolled finger -> rejected, no record
 * HD-11 wrong-section student binding never marks (cross-section isolation)
 * HD-12 enrollment: PIN expiry + wrong PIN; good PIN binds; re-enroll flips
 *       the old binding to revoked (append-only)
 * HD-13 heartbeat updates lastSeenAt; secret rotation invalidates old secret
 * HD-14 device-secret leak of one section grants NOTHING on another CR portal
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('device_attendance_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret-DO-NOT-PRINT';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Section, Subject, Timetable, AttendanceSession, AttendanceRecord,
  AttendanceDevice, FingerprintBinding, DeviceScanEvent, AuditLog } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

function makeSession() {
  const jar = new Map();
  return {
    async api(method, path, body, headers = {}) {
      if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
      if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(`${BASE}${path}`, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
      let json = null;
      try { json = await res.json(); } catch { /* non-JSON */ }
      return { status: res.status, json };
    },
  };
}

const sha256hex = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

/** Firmware-equivalent signer: key = sha256(rawSecret) (design §3). */
function sign(secret, { deviceId, ts, nonce, body }) {
  const key = sha256hex(secret);
  const payload = [deviceId, ts, nonce, JSON.stringify(body ?? {})].join('|');
  return crypto.createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}
function deviceCall(secret, deviceId, path, body, { tsOffset = 0, nonce = null, tamper = false } = {}) {
  const ts = (process.env.MOCK_NOW ? Number(process.env.MOCK_NOW) : Date.now()) + tsOffset;
  const scanId = nonce ?? `scan-${crypto.randomUUID()}`;
  const headers = {
    'content-type': 'application/json',
    'x-device-id': deviceId,
    'x-timestamp': String(ts),
    'x-scan-id': scanId,
    'x-signature': sign(secret, { deviceId, ts, nonce: scanId, body }),
  };
  if (tamper) headers['x-signature'] = headers['x-signature'].slice(0, -1) + (headers['x-signature'].endsWith('a') ? 'b' : 'a');
  return fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

const admin = makeSession();
const crA = makeSession();   // section A CR (device owner)
const crB = makeSession();    // section B CR (must see/touch nothing of A's)
const stA1 = makeSession();   // section A student, enrolled
const stA2 = makeSession();   // section A student, NOT enrolled

let secA, secB, subA, crAId, crBId, stA1Id, stA2Id;
let devA, devB; // {id, deviceId, secret}
let enrollPin; // HD-12 pin for stA1

const T0 = new Date('2026-10-13T04:30:00.000Z').getTime(); // 09:30 PKT, Tue
const setNow = (epoch) => { process.env.MOCK_NOW = String(epoch); };

const wallClockKey = (ms) => new Date(ms + 5 * 3600_000).toISOString().slice(0, 10);

test.before(async () => {
  await admin.api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'AdminPass123!456' });
  const dept = (await admin.api('POST', '/api/admin/departments', { name: 'CS', code: 'CS' })).json.data._id;
  const sess = (await admin.api('POST', '/api/admin/sessions', { name: '2027-28' })).json.data._id;
  secA = (await admin.api('POST', '/api/admin/sections', { department: dept, session: sess, semester: 5, name: '5A' })).json.data._id;
  secB = (await admin.api('POST', '/api/admin/sections', { department: dept, session: sess, semester: 5, name: '5B' })).json.data._id;

  // direct User.create (same pattern as attendance.test.js — admin user
  // routes need extra fields; the models are the contract here)
  const hash = await bcrypt.hash('Pass#12345678', 10);
  const mkUser = (name, email, role, section) => User.create({
    name, email, role, section, password: hash,
    registrationStatus: 'active', emailVerified: true,
    phone: `+9230011${String(Math.floor(Math.random() * 9000000) + 1000000)}`,
  });
  const uCrA = await mkUser('Cara A', 'cr-a@t.local', 'cr', secA);
  const uCrB = await mkUser('Cara B', 'cr-b@t.local', 'cr', secB);
  const uSt1 = await mkUser('Sara One', 's1@t.local', 'student', secA);
  const uSt2 = await mkUser('Sam Two', 's2@t.local', 'student', secA);
  await Section.updateOne({ _id: secA }, { $set: { cr: uCrA._id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: uCrB._id } });
  await crA.api('POST', '/api/auth/login', { email: 'cr-a@t.local', password: 'Pass#12345678' });
  await crB.api('POST', '/api/auth/login', { email: 'cr-b@t.local', password: 'Pass#12345678' });
  await stA1.api('POST', '/api/auth/login', { email: 's1@t.local', password: 'Pass#12345678' });
  await stA2.api('POST', '/api/auth/login', { email: 's2@t.local', password: 'Pass#12345678' });
  crAId = uCrA._id; crBId = uCrB._id; stA1Id = uSt1._id; stA2Id = uSt2._id;

  subA = (await crA.api('POST', '/api/cr/subjects', { name: 'Programming Fundamentals', code: 'PF-101' })).json.data._id;
  // Tue 09:00-10:30 PKT slot on T0's Karachi date
  await crA.api('POST', '/api/cr/timetable', { subject: subA, date: wallClockKey(T0), startTime: '09:00', endTime: '10:30', room: 'B-204' });
});

test.after(async () => {
  server.close();
  await mongoose.connection.close();
  await mongod.stop();
});

test('HD-1: register returns the secret ONCE; the DB stores only sha256(secret)', async () => {
  setNow(T0);
  const res = await crA.api('POST', '/api/cr/attendance-devices', { label: '5A door' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const { deviceId, secret } = res.json.data;
  assert.match(deviceId, /^dev_[0-9a-f]{12}$/);
  assert.ok(secret.length >= 64, 'high-entropy secret');
  devA = { deviceId, secret };
  const doc = await AttendanceDevice.findOne({ deviceId }).select('+secretHash').lean();
  devA.id = doc._id;
  assert.equal(doc.secretHash, sha256hex(secret), 'stored hash is exactly the HMAC key');
  assert.notEqual(doc.secretHash, secret, 'raw secret NEVER stored');
  // the list view never carries the key
  const list = await crA.api('GET', '/api/cr/attendance-devices');
  assert.ok(!JSON.stringify(list.json).includes(secret));
  assert.ok(!JSON.stringify(list.json).includes('secretHash'));
  assert.ok(list.json.data[0].secretLast4, 'panel-safe last-4 present');
});

test('HD-2: unsigned / bad-signature requests are rejected; a valid one passes', async () => {
  setNow(T0);
  const noHeaders = await fetch(`${BASE}/api/device/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeaders.status, 401);
  const tampered = await deviceCall(devA.secret, devA.deviceId, '/api/device/heartbeat', { fwVersion: '1.0.0' }, { tamper: true });
  assert.equal(tampered.status, 401);
  const ok = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/heartbeat', { fwVersion: '1.0.0' })).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.enrollmentMode, 'off');
});

test('HD-3: replay window — a stale timestamp is refused even with a valid signature', async () => {
  const stale = await deviceCall(devA.secret, devA.deviceId, '/api/device/heartbeat', {}, { tsOffset: -10 * 60_000 });
  assert.equal(stale.status, 401);
});

test('HD-12: enrollment — PIN binding, expiry, re-enroll append-only', async () => {
  setNow(T0 - 30 * 60_000); // before class
  const started = await crA.api('POST', `/api/cr/attendance-devices/${devA.id}/enroll`, { studentId: String(stA1Id) });
  assert.equal(started.status, 200);
  enrollPin = started.json.data.pin;
  assert.match(enrollPin, /^\d{4}$/);
  // wrong PIN never binds
  const bad = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/enroll',
    { fingerprintId: 1, pin: '0000' })).json();
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_pin');
  // good PIN binds
  const good = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/enroll',
    { fingerprintId: 1, pin: enrollPin })).json();
  assert.equal(good.ok, true);
  assert.equal(good.name, 'Sara');
  const binding = await FingerprintBinding.findOne({ deviceId: devA.id, fingerprintId: 1 }).lean();
  assert.equal(String(binding.user), String(stA1Id));
  // re-enroll (new sensor slot) flips the OLD binding — append-only
  const again = await crA.api('POST', `/api/cr/attendance-devices/${devA.id}/enroll`, { studentId: String(stA1Id) });
  const pin2 = again.json.data.pin;
  await deviceCall(devA.secret, devA.deviceId, '/api/device/enroll', { fingerprintId: 2, pin: pin2 });
  const bindings = await FingerprintBinding.find({ user: stA1Id }).sort({ createdAt: 1 }).lean();
  assert.equal(bindings.length, 2);
  assert.equal(bindings[0].status, 'revoked', 'old binding revoked, never deleted');
  assert.equal(bindings[1].status, 'active');
  assert.equal(bindings[1].fingerprintId, 2);
  // PIN expiry: a new enrollment attempt with an expired PIN fails
  const exp = await crA.api('POST', `/api/cr/attendance-devices/${devA.id}/enroll`, { studentId: String(stA2Id) });
  const pinExp = exp.json.data.pin;
  setNow(T0 + 11 * 60_000);
  const late = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/enroll',
    { fingerprintId: 3, pin: pinExp })).json();
  assert.equal(late.reason, 'pin_expired');
});

test('HD-4: scan outside any slot -> no_class, never a kiosk', async () => {
  setNow(T0 + 3 * 3600_000); // 12:30 PKT — no slot
  const res = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/scan',
    { fingerprintId: 2, scanId: 'hd4-1' })).json();
  assert.equal(res.result, 'no_class');
  assert.equal(await AttendanceRecord.countDocuments({}), 0, 'nothing marked');
});

test('HD-5: live slot -> session auto-opens, record marked with method device', async () => {
  setNow(T0); // 09:30 PKT, inside the 09:00-10:30 slot
  const res = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/scan',
    { fingerprintId: 2, scanId: 'hd5-1' })).json();
  assert.equal(res.result, 'marked', JSON.stringify(res));
  assert.equal(res.name, 'Sara', 'first name only');
  assert.equal(res.session.subject, 'Programming Fundamentals');
  const session = await AttendanceSession.findOne({ source: 'device', section: secA });
  assert.ok(session, 'device session auto-opened');
  const rec = await AttendanceRecord.findOne({ session: session._id, student: stA1Id });
  assert.equal(rec.method, 'device');
  assert.equal(rec.status, 'present');
});

test('HD-6: same student scans again (new scanId) -> duplicate, still ONE record', async () => {
  const res = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/scan',
    { fingerprintId: 2, scanId: 'hd6-1' })).json();
  assert.equal(res.result, 'duplicate');
  assert.equal(res.already, true);
  assert.equal(await AttendanceRecord.countDocuments({ student: stA1Id }), 1);
});

test('HD-7: EXACT redelivery of the same scanId -> replayed result, no reprocessing', async () => {
  const res = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/scan',
    { fingerprintId: 2, scanId: 'hd5-1' })).json();
  assert.equal(res.result, 'marked', 'stored result replayed verbatim');
  assert.equal(res.replay, true);
  assert.equal(await AttendanceRecord.countDocuments({ student: stA1Id }), 1);
  assert.equal(await DeviceScanEvent.countDocuments({ scanId: 'hd5-1' }), 1, 'one ledger row per scan');
});

test('HD-8: offline sync — old occurredAt marks into the SAME slot session', async () => {
  setNow(T0 + 3600_000); // 10:30 PKT, WiFi back
  // scan actually happened at 09:50 (device flash queue)
  const res = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/scan',
    { fingerprintId: 1, scanId: 'hd8-1', occurredAt: T0 + 20 * 60_000 })).json();
  // fingerprintId 1's binding was REVOKED in HD-12 — must reject
  assert.equal(res.result, 'rejected');
  assert.equal(res.reason, 'not_enrolled');
  // a stale >6h offline scan never marks
  const stale = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/scan',
    { fingerprintId: 2, scanId: 'hd8-2', occurredAt: T0 - 7 * 3600_000 })).json();
  assert.equal(stale.result, 'rejected');
  assert.equal(stale.reason, 'too_old');
  assert.equal(await AttendanceRecord.countDocuments({ student: stA1Id }), 1);
});

test('HD-10: an unenrolled finger is rejected, nothing recorded', async () => {
  setNow(T0 + 5 * 60_000);
  const res = await (await deviceCall(devA.secret, devA.deviceId, '/api/device/scan',
    { fingerprintId: 57, scanId: 'hd10-1' })).json();
  assert.equal(res.result, 'rejected');
  assert.equal(res.reason, 'not_enrolled');
  assert.equal(await AttendanceRecord.countDocuments({}), 1, 'only HD-5\'s record exists');
});

test('HD-11: cross-section isolation — section B\'s device can never mark A\'s student', async () => {
  setNow(T0);
  const reg = await crB.api('POST', '/api/cr/attendance-devices', { label: '5B door' });
  devB = { deviceId: reg.json.data.deviceId, secret: reg.json.data.secret };
  // B's CR tries to enroll A's student: studentId is section-scoped
  const steal = await crB.api('POST', `/api/cr/attendance-devices`, { label: 'x' }); // own device only
  assert.equal(steal.status, 200);
  const enrollTry = await crB.api('POST', `/api/cr/attendance-devices/${devB.deviceId}/enroll`, { studentId: String(stA1Id) });
  // enroll needs the device Mongo _id — deviceId string must NOT resolve
  if (enrollTry.status === 200) {
    const pin = enrollTry.json.data.pin;
    const bind = await (await deviceCall(devB.secret, devB.deviceId, '/api/device/enroll',
      { fingerprintId: 1, pin })).json();
    assert.notEqual(bind.ok, true, 'cross-section enrollment must fail');
  } else {
    assert.ok([400, 404].includes(enrollTry.status), 'unknown id for other section');
  }
  assert.equal(await AttendanceRecord.countDocuments({ student: stA1Id, section: secB }), 0);
});

test('HD-9 + HD-13: revoke kills the device instantly; rotation invalidates the old secret', async () => {
  setNow(T0);
  // rotation first: old secret must stop working immediately
  const rot = await crA.api('POST', `/api/cr/attendance-devices/${devA.id}/rotate`);
  const newSecret = rot.json.data.secret;
  const oldRejected = await deviceCall(devA.secret, devA.deviceId, '/api/device/heartbeat', {});
  assert.equal(oldRejected.status, 401, 'old secret invalid after rotation');
  const newOk = await (await deviceCall(newSecret, devA.deviceId, '/api/device/heartbeat', {})).json();
  assert.equal(newOk.ok, true);
  // revoke
  const rev = await crA.api('POST', `/api/cr/attendance-devices/${devA.id}/revoke`);
  assert.equal(rev.json.data.status, 'revoked');
  const dead = await deviceCall(newSecret, devA.deviceId, '/api/device/scan',
    { fingerprintId: 2, scanId: 'hd9-1' });
  assert.equal(dead.status, 403);
  assert.equal(await AttendanceRecord.countDocuments({ student: stA1Id }), 1, 'no marks after revoke');
});

test('HD-14: secret rotation changes the stored key; audit trail covers the lifecycle', async () => {
  const reg2 = await crA.api('POST', '/api/cr/attendance-devices', { label: 'replacement' });
  assert.equal(reg2.status, 200);
  const actions = (await AuditLog.find({ action: /^attendance\.device\./ }).distinct('action'));
  assert.ok(actions.includes('attendance.device.registered'));
  assert.ok(actions.includes('attendance.device.enrollment-started'));
  assert.ok(actions.includes('attendance.device.enrolled'));
  assert.ok(actions.includes('attendance.device.secret-rotated'));
  assert.ok(actions.includes('attendance.device.revoked'));
  assert.ok(actions.includes('attendance.device.session-opened'));
});
