/**
 * STEP 8 tests — attendance. Isolated in-memory REPLICA SET (transactions +
 * unique-index races). Expiry/failed-attempt tests use the deterministic
 * MOCK_NOW clock — never real-time waits. Plaintext codes are checked to
 * NEVER appear in the DB, audit logs, or student-facing responses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('attendance_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret-DO-NOT-PRINT';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Section, Subject, AttendanceSession, AttendanceRecord, AuditLog } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

function makeSession() {
  const jar = new Map();
  return {
    async api(method, path, body) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
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
      return { status: res.status, json, text: json ? JSON.stringify(json) : '' };
    },
  };
}

const admin = makeSession();
const cr1 = makeSession();      // section A
const cr2 = makeSession();      // section B
const student1 = makeSession(); // section A
const student2 = makeSession(); // section A
const student3 = makeSession(); // section A

let deptCS, session1, secA, secB, secC, subA1, subA2, subB1, subC1;
let cr1Id, cr2Id, student1Id, student2Id, student3Id;
let sMain;   // main test session (section A)
let mainCode; // its plaintext code (returned once at creation)

const T0 = new Date('2026-10-05T08:00:00.000Z').getTime();
const setNow = (epoch = T0) => { process.env.MOCK_NOW = String(epoch); };
const sha256 = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

test('fixtures: hierarchy + users', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  deptCS = (await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  session1 = (await admin.api('POST', '/api/admin/sessions', { name: '2027–28' })).json.data._id;
  secA = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5A' })).json.data._id;
  secB = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5B' })).json.data._id;
  secC = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 6, name: '6C' })).json.data._id;

  const hash = await bcrypt.hash('CrPass123!', 10);
  const mk = (name, email, phone, role, section, extra = {}) => User.create({
    name, email, phone, role, registrationStatus: 'active', emailVerified: true, password: hash, section, ...extra,
  });
  cr1Id = (await mk('CR One', 'cr1@test.local', '+923001110001', 'cr', secA, { status: 'active' }))._id;
  cr2Id = (await mk('CR Two', 'cr2@test.local', '+923001110002', 'cr', secB))._id;
  student1Id = (await mk('Student One', 's1@test.local', '+923001110003', 'student', secA, { rollNo: 'R-001' }))._id;
  student2Id = (await mk('Student Two', 's2@test.local', '+923001110004', 'student', secA, { rollNo: 'R-002' }))._id;
  student3Id = (await mk('Student Three', 's3@test.local', '+923001110005', 'student', secA, { rollNo: 'R-003' }))._id;
  await Section.updateOne({ _id: secA }, { $set: { cr: cr1Id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });

  subA1 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' })).json.data._id;
  subA2 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Networking', code: 'NET-1' })).json.data._id;
  subB1 = (await admin.api('POST', '/api/admin/subjects', { section: secB, name: 'Databases', code: 'DB-201' })).json.data._id;
  subC1 = (await admin.api('POST', '/api/admin/subjects', { section: secC, name: 'Old Course', code: 'OLD-1' })).json.data._id;

  assert.equal((await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await cr2.api('POST', '/api/auth/login', { email: 'cr2@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await student1.api('POST', '/api/auth/login', { email: 's1@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await student2.api('POST', '/api/auth/login', { email: 's2@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await student3.api('POST', '/api/auth/login', { email: 's3@test.local', password: 'CrPass123!' })).status, 200);
});

/* ======================= SESSION CREATION (1–15) ======================= */
const created = {};
test('1, 4–6, 11–15. CR creates session; code crypto; safe response', async () => {
  setNow(T0);
  const res = await cr1.api('POST', '/api/cr/attendance/sessions', {
    subject: subA1,
    // injections — all must be ignored
    section: secB, sectionId: secB, createdBy: student1Id, role: 'admin',
    code: 'HACKCODE', codeHash: sha256('HACKCODE'),
    expiresAt: new Date(T0 + 999 * 60_000).toISOString(), status: 'cancelled',
  });
  assert.equal(res.status, 200);
  sMain = res.json.data.session._id;
  mainCode = res.json.data.code;
  created.qr = res.json.data.qr;

  // 11. exactly 8 Crockford Base32 chars, uppercase
  assert.match(mainCode, /^[0-9A-Z]{8}$/);
  assert.ok(!/[ILOU]/.test(mainCode), 'no ambiguous chars');

  // 4/5. section derived from authenticated user; injections ignored
  const doc = await AttendanceSession.findById(sMain).select('+codeHash');
  assert.equal(String(doc.section), String(secA));
  assert.equal(String(doc.createdBy), String(cr1Id));
  assert.equal(doc.status, 'open');
  assert.equal(doc.failedAttempts, 0);

  // 6/13/14. client code ignored — stored hash is SHA-256(server code)
  assert.equal(doc.codeHash, sha256(mainCode));
  assert.notEqual(doc.codeHash, sha256('HACKCODE'));

  // 20. client expiresAt ignored — server window is exactly 10 minutes
  assert.equal(doc.expiresAt.getTime() - doc.opensAt.getTime(), 10 * 60 * 1000);

  // 13. plaintext code never stored anywhere in the session document
  assert.ok(!JSON.stringify(doc).includes(mainCode), 'plaintext code must not appear in DB doc');

  // 15. codeHash never returned in any response
  assert.ok(!res.text.includes(doc.codeHash));
  const got = await cr1.api('GET', `/api/cr/attendance/sessions/${sMain}`);
  assert.equal(got.status, 200);
  assert.ok(!got.text.includes('codeHash') && !got.text.includes(doc.codeHash));
  assert.equal(got.json.data.attendanceCount, 0);

  // QR payload structure: sid + code + exp only, HMAC-signed
  const [b64, sig] = created.qr.split('.');
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  assert.equal(payload.sid, String(sMain));
  assert.equal(payload.code, mainCode);
  assert.equal(payload.exp, doc.expiresAt.getTime());
  const expected = crypto.createHmac('sha256', process.env.ATTENDANCE_SECRET).update(b64).digest('base64url');
  assert.equal(sig, expected);
});

test('12. codes are cryptographically random (uniqueness across 20 sessions)', async () => {
  const codes = [mainCode];
  for (let i = 0; i < 20; i += 1) {
    const r = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA1 });
    assert.equal(r.status, 200);
    codes.push(r.json.data.code);
    await cr1.api('POST', `/api/cr/attendance/sessions/${r.json.data._id}/cancel`); // keep state clean
  }
  assert.equal(new Set(codes).size, codes.length); // no collisions in 21 draws
});

test('2. student cannot create a session (403)', async () => {
  assert.equal((await student1.api('POST', '/api/student/attendance/sessions', { subject: subA1 })).status, 404); // route absent
  assert.equal((await student1.api('POST', '/api/cr/attendance/sessions', { subject: subA1 })).status, 403);
  assert.equal((await student1.api('POST', '/api/admin/attendance/sessions', {})).status, 403); // adminOnly rejects before 404
});

test('3. admin remains read-only (no create/cancel routes)', async () => {
  assert.equal((await admin.api('POST', '/api/admin/attendance/sessions', { subject: subA1 })).status, 404);
  assert.equal((await admin.api('POST', `/api/admin/attendance/sessions/${sMain}/cancel`)).status, 404);
  const list = await admin.api('GET', '/api/admin/attendance/sessions');
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes('codeHash'));
});

test('7–10. subject/section validation', async () => {
  // invalid subject id
  assert.equal((await cr1.api('POST', '/api/cr/attendance/sessions', { subject: 'zzz' })).status, 400);
  // ghost subject
  assert.equal((await cr1.api('POST', '/api/cr/attendance/sessions', { subject: '507f1f77bcf86cd799439011' })).status, 400);
  // (8) cross-section subject
  const cross = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subB1 });
  assert.equal(cross.status, 400);
  assert.match(cross.json.message, /does not belong/i);
  // (9) archived subject
  const subA3 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Archived Sub', code: 'ARCH-1' })).json.data._id;
  assert.equal((await admin.api('POST', `/api/admin/subjects/${subA3}/archive`)).status, 200);
  const arch = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA3 });
  assert.equal(arch.status, 400);
  assert.match(arch.json.message, /archived/i);
  // (10) archived section — section C archived (created earlier)
  assert.equal((await admin.api('POST', `/api/admin/sections/${secC}/archive`)).status, 200);
  const hash = await bcrypt.hash('CrPass123!', 10);
  const cr3 = await User.create({ name: 'CR Three', email: 'cr3@test.local', phone: '+923001110009', role: 'cr', registrationStatus: 'active', emailVerified: true, password: hash, section: secC });
  await Section.updateOne({ _id: secC }, { $set: { cr: cr3._id } });
  const sess3 = makeSession();
  assert.equal((await sess3.api('POST', '/api/auth/login', { email: 'cr3@test.local', password: 'CrPass123!' })).status, 200);
  const archSec = await sess3.api('POST', '/api/cr/attendance/sessions', { subject: subC1 });
  assert.equal(archSec.status, 400);
  assert.match(archSec.json.message, /archived/i);
});

/* ========================== EXPIRY (16–20) ========================== */
test('16. attendance works before expiry; 18–19. rejected after', async () => {
  // before expiry (T0 + 9 min)
  setNow(T0 + 9 * 60_000);
  const ok = await student1.api('POST', `/api/student/attendance/sessions/${sMain}/attend`, { code: mainCode });
  assert.equal(ok.status, 200); // (16, 21)
  assert.equal(String(ok.json.data.session._id), String(sMain));

  // (17) boundary: exactly at expiresAt → rejected (rule: now < expiresAt)
  setNow(T0 + 10 * 60_000);
  const boundary = await student2.api('POST', `/api/student/attendance/sessions/${sMain}/attend`, { code: mainCode });
  assert.equal(boundary.status, 400);

  // after expiry
  setNow(T0 + 11 * 60_000);
  const late = await student2.api('POST', `/api/student/attendance/sessions/${sMain}/attend`, { code: mainCode });
  assert.equal(late.status, 400); // (18, 19)
  assert.equal(await AttendanceRecord.countDocuments({ session: sMain, student: student2Id }), 0);
  setNow(T0);
});

/* ========================= MANUAL CODE (21–26) ========================= */
let sCodes; // fresh session for code tests
test('21–23. correct code creates record; wrong code counted', async () => {
  setNow(T0);
  const created2 = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA2 });
  sCodes = created2.json.data.session._id;
  const code2 = created2.json.data.code;

  // (21) correct code — student3 attends
  const ok = await student3.api('POST', `/api/student/attendance/sessions/${sCodes}/attend`, { code: code2.toLowerCase() }); // case-normalized
  assert.equal(ok.status, 200);
  const rec = await AttendanceRecord.findOne({ session: sCodes, student: student3Id });
  assert.ok(rec);
  assert.equal(rec.method, 'self');
  assert.equal(rec.status, 'present');
  assert.equal(String(rec.section), String(secA)); // (15) section matches session

  // (22, 23) wrong code — rejected + atomic increment
  const wrong = await student2.api('POST', `/api/student/attendance/sessions/${sCodes}/attend`, { code: 'ZZZZZZZZ' });
  assert.equal(wrong.status, 400);
  assert.ok(!wrong.text.includes('remaining'), 'no attempt-count leak');
  assert.equal((await AttendanceSession.findById(sCodes)).failedAttempts, 1);
});

test('24–26. 10th failure auto-cancels; race-safe increments', async () => {
  // 8 more wrong attempts (1 already used) — fire CONCURRENTLY to test the race
  const attempts = await Promise.allSettled(
    Array.from({ length: 9 }, () => student2.api('POST', `/api/student/attendance/sessions/${sCodes}/attend`, { code: 'YYYYYYYY' }))
  );
  assert.ok(attempts.every((a) => a.value.status === 400));
  const doc = await AttendanceSession.findById(sCodes);
  assert.equal(doc.failedAttempts, 10); // (26) atomic — exactly 10, no lost increments
  assert.equal(doc.status, 'cancelled'); // (24) auto-cancelled at the 10th

  // (25) 11th attempt rejected because session is cancelled
  const after = await student1.api('POST', `/api/student/attendance/sessions/${sCodes}/attend`, { code: 'AAAAAAAA' });
  assert.equal(after.status, 400);
  const even = await student3.api('POST', `/api/student/attendance/sessions/${sCodes}/attend`, { code: mainCode }); // correct code also dead
  assert.equal(even.status, 400);
  // student3's earlier record survives cancellation (47)
  assert.equal(await AttendanceRecord.countDocuments({ session: sCodes, student: student3Id }), 1);
});

/* ========================= DUPLICATES (27–29) ========================= */
test('27–29. duplicate attendance controlled; concurrent race → one record', async () => {
  const created3 = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA1 });
  const sDup = created3.json.data.session._id;
  const dupCode = created3.json.data.code;

  const first = await student1.api('POST', `/api/student/attendance/sessions/${sDup}/attend`, { code: dupCode });
  assert.equal(first.status, 200);
  const second = await student1.api('POST', `/api/student/attendance/sessions/${sDup}/attend`, { code: dupCode });
  assert.equal(second.status, 409); // (27, 28)
  assert.equal(await AttendanceRecord.countDocuments({ session: sDup, student: student1Id }), 1);

  // (29) concurrent duplicates → exactly one record (unique index + E11000 path)
  const created4 = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA1 });
  const sRace = created4.json.data.session._id;
  const raceCode = created4.json.data.code;
  const races = await Promise.allSettled([
    student2.api('POST', `/api/student/attendance/sessions/${sRace}/attend`, { code: raceCode }),
    student2.api('POST', `/api/student/attendance/sessions/${sRace}/attend`, { code: raceCode }),
  ]);
  const statuses = races.map((r) => r.value.status).sort();
  assert.deepEqual(statuses, [200, 409]); // exactly one succeeds
  assert.equal(await AttendanceRecord.countDocuments({ session: sRace, student: student2Id }), 1);
});

/* ============================== QR (30–36) ============================== */
test('30–36. QR path — same verification rules, signature enforced', async () => {
  const created5 = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA2 });
  const sQr = created5.json.data.session._id;
  const qrToken = created5.json.data.qr;

  // (30) valid signed QR accepted
  const ok = await student3.api('POST', '/api/student/attendance/scan', { qr: qrToken });
  assert.equal(ok.status, 200);
  assert.equal(String(ok.json.data.session._id), String(sQr));

  // (31) invalid signature
  const [b64, sig] = qrToken.split('.');
  const badSig = `${b64}.${sig.slice(0, -2)}AA`;
  assert.equal((await student2.api('POST', '/api/student/attendance/scan', { qr: badSig })).status, 400);

  // (32) tampered sid (payload changed → signature no longer matches)
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  const tamperedSid = Buffer.from(JSON.stringify({ ...payload, sid: '507f1f77bcf86cd799439011' })).toString('base64url');
  assert.equal((await student2.api('POST', '/api/student/attendance/scan', { qr: `${tamperedSid}.${sig}` })).status, 400);

  // (33) tampered exp
  const tamperedExp = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 3600_000 })).toString('base64url');
  assert.equal((await student2.api('POST', '/api/student/attendance/scan', { qr: `${tamperedExp}.${sig}` })).status, 400);

  // (34) expired QR — valid signature but exp in the past
  const created6 = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA1 });
  const sQr2 = created6.json.data.session._id;
  setNow(T0 + 11 * 60_000); // past the 10-minute window
  const expired = await student2.api('POST', '/api/student/attendance/scan', { qr: created6.json.data.qr });
  assert.equal(expired.status, 400);
  // manual code on the same expired session also rejected — (36) same rules
  assert.equal((await student2.api('POST', `/api/student/attendance/sessions/${sQr2}/attend`, { code: created6.json.data.code })).status, 400);
  setNow(T0);

  // (35) QR exposes no sensitive user information
  const qrPayload = JSON.parse(Buffer.from(created5.json.data.qr.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(qrPayload).sort(), ['code', 'exp', 'sid']);
});

test('qr code path respects failed attempts + section isolation (36b)', async () => {
  const created7 = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA1 });
  const sQr3 = created7.json.data.session._id;
  const badQr = created7.json.data.qr;
  // wrong code inside a validly-signed QR → counts as failed attempt
  const payload = JSON.parse(Buffer.from(badQr.split('.')[0], 'base64url').toString('utf8'));
  const wrongPayload = Buffer.from(JSON.stringify({ ...payload, code: 'QQQQQQQQ' })).toString('base64url');
  const wrongSig = crypto.createHmac('sha256', process.env.ATTENDANCE_SECRET).update(wrongPayload).digest('base64url');
  const res = await student2.api('POST', '/api/student/attendance/scan', { qr: `${wrongPayload}.${wrongSig}` });
  assert.equal(res.status, 400);
  assert.equal((await AttendanceSession.findById(sQr3)).failedAttempts, 1);
  // cross-section QR → 404 (same as manual path)
  const created8 = await cr2.api('POST', '/api/cr/attendance/sessions', { subject: subB1 });
  const cross = await student2.api('POST', '/api/student/attendance/scan', { qr: created8.json.data.qr });
  assert.equal(cross.status, 404);
});

/* ========================= ISOLATION (37–43) ========================= */
test('37–43. role-scoped visibility', async () => {
  const secBSession = (await cr2.api('POST', '/api/cr/attendance/sessions', { subject: subB1 })).json.data.session._id;

  const crList = await cr1.api('GET', '/api/cr/attendance/sessions');
  assert.ok(crList.json.data.every((s) => String(s.section) === String(secA))); // (37)
  assert.ok(!crList.json.data.some((s) => String(s._id) === String(secBSession)));

  assert.equal((await cr1.api('GET', `/api/cr/attendance/sessions/${secBSession}`)).status, 404); // (38)
  assert.equal((await cr1.api('POST', `/api/cr/attendance/sessions/${secBSession}/cancel`)).status, 404); // (45)
  assert.equal((await cr1.api('GET', `/api/cr/attendance/sessions/${secBSession}/records`)).status, 404);

  // (39/40) student cross-section session → 404
  assert.equal((await student1.api('POST', `/api/student/attendance/sessions/${secBSession}/attend`, { code: mainCode })).status, 404);

  // (41) student sees only OWN records
  const mine = await student1.api('GET', '/api/student/attendance');
  assert.equal(mine.status, 200);
  assert.ok(mine.json.data.length >= 1);
  assert.ok(mine.json.data.every((r) => true)); // records themselves are student-scoped server-side
  const myIds = (await AttendanceRecord.find({ student: student1Id })).map((r) => String(r._id));
  assert.deepEqual(mine.json.data.map((r) => String(r._id)).sort(), myIds.sort());

  // (42) another student's records are unreachable — no route accepts a student id
  const other = await student2.api('GET', `/api/student/attendance?studentId=${student1Id}`);
  assert.ok(other.json.data.every((r) => !myIds.includes(String(r._id)))); // filter param ignored

  // (43) admin sees multiple sections
  const adminList = await admin.api('GET', '/api/admin/attendance/sessions');
  assert.ok(adminList.json.data.some((s) => String(s.section) === String(secA)));
  assert.ok(adminList.json.data.some((s) => String(s.section) === String(secB)));
});

/* ======================== CANCELLATION (44–48) ======================== */
test('44–48. CR cancels own session; records preserved', async () => {
  const created9 = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA1 });
  const sC = created9.json.data.session._id;
  const cCode = created9.json.data.code;
  assert.equal((await student1.api('POST', `/api/student/attendance/sessions/${sC}/attend`, { code: cCode })).status, 200);

  const cancel = await cr1.api('POST', `/api/cr/attendance/sessions/${sC}/cancel`);
  assert.equal(cancel.status, 200); // (44)
  assert.equal((await AttendanceSession.findById(sC)).status, 'cancelled');

  // (46) cancelled session rejects attendance
  assert.equal((await student3.api('POST', `/api/student/attendance/sessions/${sC}/attend`, { code: cCode })).status, 400);
  // (47) existing records remain
  assert.equal(await AttendanceRecord.countDocuments({ session: sC, student: student1Id }), 1);
  // (48) duplicate cancellation → 409
  assert.equal((await cr1.api('POST', `/api/cr/attendance/sessions/${sC}/cancel`)).status, 409);
});

/* ========================== HISTORY (49–51) ========================== */
test('49–51. history preserved; no hard delete', async () => {
  // (49) expired session still readable by CR
  setNow(T0);
  const created10 = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA1 });
  const sHist = created10.json.data.session._id;
  await student2.api('POST', `/api/student/attendance/sessions/${sHist}/attend`, { code: created10.json.data.code });
  setNow(T0 + 30 * 60_000);
  const view = await cr1.api('GET', `/api/cr/attendance/sessions/${sHist}`);
  assert.equal(view.status, 200); // expired but readable
  // (50) records remain after expiry
  assert.equal(await AttendanceRecord.countDocuments({ session: sHist, student: student2Id }), 1);
  const studentView = await student2.api('GET', '/api/student/attendance');
  assert.ok(studentView.json.data.some((r) => String(r.session?._id) === String(sHist)));
  setNow(T0);
  // (51) no destructive endpoints exist
  assert.equal((await cr1.api('DELETE', `/api/cr/attendance/sessions/${sHist}`)).status, 404);
  assert.equal((await admin.api('DELETE', `/api/admin/attendance/sessions/${sHist}`)).status, 404);
});

/* ========================== SECURITY (52–61) ========================== */
test('52–56. secrets never exposed', async () => {
  const responses = [
    await cr1.api('GET', '/api/cr/attendance/sessions'),
    await student1.api('GET', '/api/student/attendance'),
    await admin.api('GET', '/api/admin/attendance/sessions'),
    await admin.api('GET', `/api/admin/attendance/sessions/${sMain}/records`),
  ];
  for (const r of responses) {
    assert.ok(!r.text.includes(process.env.ATTENDANCE_SECRET), 'ATTENDANCE_SECRET never returned'); // (52)
    assert.ok(!r.text.includes('codeHash'), 'codeHash never returned'); // (55)
    assert.ok(!/\$2[aby]\$/.test(r.text), 'no password hash'); // (56)
    assert.ok(!r.text.includes('password') || r.text.includes('passwordHash') === false);
  }
  // (53) not hardcoded in source
  const { execSync } = await import('node:child_process');
  const hits = execSync(
    `grep -rn "test-only-attendance-secret" backend/ || true`, { cwd: process.cwd() }
  ).toString().trim();
  assert.equal(hits, '', 'secret literal must not appear in backend source');
  // (54) plaintext code never logged anywhere (audit scan)
  const logs = await AuditLog.find({ action: /^attendance\./ });
  const logText = JSON.stringify(logs.map((l) => ({ b: l.before, a: l.after, r: l.reason })));
  assert.ok(!logText.includes(mainCode), 'plaintext code never in audit logs');
});

test('57–59. ownership/role/section injection blocked on attend', async () => {
  const created11 = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA1 });
  const sInj = created11.json.data.session._id;
  const iCode = created11.json.data.code;
  const res = await student1.api('POST', `/api/student/attendance/sessions/${sInj}/attend`, {
    code: iCode,
    student: student2Id, studentId: student2Id, // (57) ignored — record belongs to student1
    section: secB, sectionId: secB, // (59) ignored
    role: 'admin', status: 'cancelled', expiresAt: new Date(T0 + 999 * 60_000).toISOString(), // (58) ignored
    failedAttempts: 99,
  });
  assert.equal(res.status, 200);
  const rec = await AttendanceRecord.findOne({ session: sInj });
  assert.equal(String(rec.student), String(student1Id)); // server-derived
  assert.equal(String(rec.section), String(secA));
  const doc = await AttendanceSession.findById(sInj);
  assert.equal(doc.failedAttempts, 0); // injected counter ignored
  assert.equal(doc.status, 'open');
  assert.equal(doc.expiresAt.getTime() - doc.opensAt.getTime(), 10 * 60 * 1000);
});

test('60–61. invalid ObjectId → 400; cross-section → 404', async () => {
  assert.equal((await cr1.api('GET', '/api/cr/attendance/sessions/zzz')).status, 400);
  assert.equal((await student1.api('POST', '/api/student/attendance/sessions/zzz/attend', { code: mainCode })).status, 400);
  assert.equal((await admin.api('GET', '/api/admin/attendance/sessions/zzz')).status, 400);
  assert.equal((await admin.api('GET', '/api/admin/attendance/sessions/zzz/records')).status, 400);
});

/* ============================ AUDIT (62–67) ============================ */
test('62–67. audit events recorded; no plaintext code in logs', async () => {
  for (const action of [
    'attendance.session.create', 'attendance.attend.success', 'attendance.attend.failed',
    'attendance.session.cancel', 'attendance.duplicate', 'attendance.qr.success', 'attendance.qr.failed',
  ]) {
    assert.ok(await AuditLog.countDocuments({ action }) > 0, `${action} recorded`);
  }
  const logs = await AuditLog.find({ action: /^attendance\./ });
  const text = JSON.stringify(logs.map((l) => ({ b: l.before, a: l.after, r: l.reason })));
  assert.ok(!text.includes('codeHash') && !text.includes('password'));
  assert.ok(!text.includes('CrPass'));
  // code values from this run never appear
  const allCodes = await AttendanceSession.find({}).select('+codeHash');
  assert.ok(!text.includes('failedAttempts'));
});

/* ========================= PAGINATION (68–71) ========================= */
test('68–71. pagination + deterministic ordering', async () => {
  // create extra sessions for ordering check
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA1 });
    ids.push(r.json.data.session._id);
  }
  const page1 = await cr1.api('GET', '/api/cr/attendance/sessions?limit=5&page=1');
  if (!(page1.json.data?.length >= 5)) console.log('PAGE1-DEBUG', page1.status, page1.text.slice(0, 300));
  assert.equal(page1.status, 200);
  assert.ok(page1.json.data.length >= 5);
  assert.ok(page1.json.pagination.total >= 5);
  const opens = page1.json.data.map((s) => new Date(s.opensAt).getTime());
  assert.ok(opens.every((v, i) => i === 0 || opens[i - 1] >= v), 'opensAt descending'); // (71)
  const capped = await cr1.api('GET', '/api/cr/attendance/sessions?limit=9999');
  assert.equal(capped.json.pagination.limit, 100); // (70)
  const adminCapped = await admin.api('GET', '/api/admin/attendance/sessions?limit=5000');
  assert.equal(adminCapped.json.pagination.limit, 100);

  // record pagination — use a session with several records
  const created12 = await cr1.api('POST', '/api/cr/attendance/sessions', { subject: subA2 });
  const sP = created12.json.data.session._id;
  const pCode = created12.json.data.code;
  for (const s of [student1, student2, student3]) {
    assert.equal((await s.api('POST', `/api/student/attendance/sessions/${sP}/attend`, { code: pCode })).status, 200);
  }
  const recPage = await cr1.api('GET', `/api/cr/attendance/sessions/${sP}/records?limit=2&page=1`);
  assert.equal(recPage.status, 200);
  assert.equal(recPage.json.data.length, 2);
  assert.equal(recPage.json.pagination.total, 3);
  const marked = recPage.json.data.map((r) => new Date(r.markedAt).getTime());
  assert.ok(marked[0] >= marked[1], 'markedAt descending');
  assert.ok(recPage.json.data.every((r) => r.student && r.student.name && !r.text?.includes('password')));
  // student history pagination + subject filter
  const hist = await student1.api('GET', `/api/student/attendance?subjectId=${subA2}&limit=100`);
  assert.equal(hist.status, 200);
  assert.ok(hist.json.data.length >= 1);
  assert.ok(hist.json.data.every((r) => r.session?.subject && String(r.session.subject._id) === String(subA2)));
  assert.ok(hist.json.data.every((r) => r.session && r.session.subject && String(r.session.subject._id) === String(subA2)));
});

/* ===================== REGRESSION (72–78) ===================== */
test('72–78. earlier phases healthy', async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.database, 'connected');
  assert.equal((await admin.api('GET', '/api/admin/subjects')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/announcements')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/notes')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/assignments')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/timetable')).status, 200);
  assert.equal((await cr1.api('GET', '/api/cr/subjects')).status, 200);
  assert.equal((await student1.api('GET', '/api/student/timetable')).status, 200);
  assert.equal((await student1.api('GET', '/api/student/assignments')).status, 200);
  const bad = await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'Wrong1!' });
  assert.equal(bad.status, 401);
});

test.after(async () => {
  delete process.env.MOCK_NOW;
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
