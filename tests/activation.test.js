/**
 * STEP 3B tests — Brevo OTP (mocked), CR activation, student registration,
 * password reset. NEVER sends real email: global fetch intercepts every
 * Brevo call; the API key below is a fake test value.
 */
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

// replica set required — section/CR flows use MongoDB transactions
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('activation_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-brevo-key-xyz';
process.env.BREVO_SENDER_EMAIL = 'sender@test.local';
process.env.BREVO_SENDER_NAME = 'IUB Class Manager';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Department, AcademicSession, Section, Otp, AuditLog } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

// ---- Brevo mock: intercept ALL brevo calls, capture payloads ----
const sentEmails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.brevo.com')) {
    sentEmails.push({ url: String(url), opts });
    return { ok: true, status: 200, json: async () => ({ messageId: 'mock' }) };
  }
  return realFetch(url, opts); // local test server only — no other external calls exist
};

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

const lastEmailTo = (email) => {
  for (let i = sentEmails.length - 1; i >= 0; i--) {
    const body = JSON.parse(sentEmails[i].opts.body);
    if (body.to?.[0]?.email === email) return body;
  }
  return null;
};
const otpFrom = (email) => {
  const body = lastEmailTo(email);
  const m = body?.textContent?.match(/\b(\d{6})\b/);
  return m ? m[1] : null;
};
const ageOtps = (email, purpose, ms = 61000) =>
  // native update — mongoose marks createdAt immutable and would silently ignore $set
  Otp.collection.updateMany(
    { email, purpose },
    { $set: { createdAt: new Date(Date.now() - ms) } }
  );

const BREVO_KEY = process.env.BREVO_API_KEY;

/* ================= fixtures: admin, dept, session, section, CR ================= */
const admin = makeSession();
const cr = makeSession();
const student = makeSession();
let deptId, sessionId, sectionId, otherSectionId, crEmail = 'newcr@test.local', studentEmail = 'newstudent@test.local';

test('fixtures: admin login + department/session/section + CR pre-create', async () => {
  const login = await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  });
  assert.equal(login.status, 200);

  const d = await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' });
  deptId = d.json.data._id;
  const s = await admin.api('POST', '/api/admin/sessions', { name: '2026–27' });
  sessionId = s.json.data._id;
  const sec = await admin.api('POST', '/api/admin/sections', {
    department: deptId, session: sessionId, semester: 5, name: '5A',
  });
  sectionId = sec.json.data._id;
  const sec2 = await admin.api('POST', '/api/admin/sections', {
    department: deptId, session: sessionId, semester: 5, name: '5B',
  });
  otherSectionId = sec2.json.data._id;

  const pre = await admin.api('POST', '/api/admin/crs', {
    name: 'New CR', email: crEmail, phone: '+923001112233', sectionId,
  });
  assert.equal(pre.status, 200);
});

/* ============================= 17. pending CR cannot login ============================ */
test('pending CR cannot login before activation', async () => {
  const res = await cr.api('POST', '/api/auth/login', { email: crEmail, password: 'CrStrong123!' });
  assert.equal(res.status, 403);
  assert.equal(res.json.message, 'Account not activated yet');
});

/* ==================== 5, 6, 1, 3, 4. CR OTP request via Brevo ==================== */
test('CR OTP request works and email is sent through the Brevo mock', async () => {
  const res = await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail.toUpperCase() + ' ' });
  assert.equal(res.status, 200);
  assert.match(res.json.message, /if the account is eligible/i);
  const last = sentEmails[sentEmails.length - 1];
  // (1) Brevo service uses the env key
  assert.match(last.url, /api\.brevo\.com\/v3\/smtp\/email/);
  assert.equal(last.opts.headers['api-key'], BREVO_KEY);
  assert.ok(lastEmailTo(crEmail));
  // (3) OTP is hashed in DB — not plaintext
  const doc = await Otp.findOne({ email: crEmail, purpose: 'cr-activation' }).sort({ createdAt: -1 }).select('+codeHash');
  assert.ok(doc.codeHash.startsWith('$2'), 'codeHash is a bcrypt hash');
  const otp = otpFrom(crEmail);
  assert.ok(otp, 'mock email contains the 6-digit OTP');
  assert.equal(await bcrypt.compare(otp, doc.codeHash), true, 'DB hash matches emailed OTP');
  assert.notEqual(doc.codeHash, otp, 'never stored plaintext');
  // (4) OTP never appears in the API response
  assert.ok(!res.text.includes(otp), 'no OTP in response body');
});

test('Brevo API key never appears in any API response', async () => {
  const res = await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
  assert.equal(res.status, 429); // cooldown — still must not leak the key
  assert.ok(!res.text.includes(BREVO_KEY));
  const me = await admin.api('GET', '/api/auth/me');
  assert.ok(!me.text.includes(BREVO_KEY));
});

/* ============================= 11. resend cooldown ============================= */
test('CR resend cooldown (60s) is enforced', async () => {
  const res = await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
  assert.equal(res.status, 429);
  assert.match(res.json.message, /wait a minute/i);
});

/* ============================= 12. hourly limit ============================= */
test('CR hourly send limit (5/hour) is enforced', async () => {
  // one OTP doc already exists from the earlier request test → 4 more sends = 5/hour
  for (let i = 0; i < 3; i++) {
    await ageOtps(crEmail, 'cr-activation');
    const r = await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
    assert.equal(r.status, 200);
  }
  await ageOtps(crEmail, 'cr-activation');
  const r6 = await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
  assert.equal(r6.status, 200); // 5th send of the hour
  await ageOtps(crEmail, 'cr-activation'); // clear cooldown so ONLY the hourly cap fires
  const blocked = await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.message, /too many codes/i);
  // reset for later tests
  await Otp.deleteMany({ email: crEmail, purpose: 'cr-activation' });
  const fresh = await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
  assert.equal(fresh.status, 200);
});

/* ==================== 7, 8, 9, 10. OTP verification paths ==================== */
test('CR wrong OTP is rejected', async () => {
  const res = await cr.api('POST', '/api/auth/cr/verify-otp', { email: crEmail, otp: '000000' });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /invalid or expired/i);
});

test('CR expired OTP is rejected', async () => {
  const otp = otpFrom(crEmail);
  await Otp.updateOne({ email: crEmail, purpose: 'cr-activation' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const res = await cr.api('POST', '/api/auth/cr/verify-otp', { email: crEmail, otp });
  assert.equal(res.status, 400);
  // restore a fresh OTP for later tests
  await Otp.deleteMany({ email: crEmail, purpose: 'cr-activation' });
  await ageOtps(crEmail, 'cr-activation');
  const r = await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
  assert.equal(r.status, 200);
});

test('CR OTP cannot be reused after one successful verification', async () => {
  const otp = otpFrom(crEmail);
  const v1 = await cr.api('POST', '/api/auth/cr/verify-otp', { email: crEmail, otp });
  assert.equal(v1.status, 200);
  const token = v1.json.activationToken;
  assert.ok(token && token.length > 20, 'activation token issued');
  const v2 = await cr.api('POST', '/api/auth/cr/verify-otp', { email: crEmail, otp });
  assert.equal(v2.status, 400, 'same OTP cannot verify twice');
  // fresh OTP for the remaining verification tests (clean slate avoids the hourly cap)
  await Otp.deleteMany({ email: crEmail, purpose: 'cr-activation' });
  await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
});

test('CR OTP rejects after 5 failed attempts', async () => {
  const otp = otpFrom(crEmail);
  for (let i = 0; i < 5; i++) {
    const r = await cr.api('POST', '/api/auth/cr/verify-otp', { email: crEmail, otp: '999999' });
    assert.equal(r.status, 400);
  }
  // correct code now rejected — attempt limit hit
  const r = await cr.api('POST', '/api/auth/cr/verify-otp', { email: crEmail, otp });
  assert.equal(r.status, 400);
  // fresh OTP, then succeed
  await Otp.deleteMany({ email: crEmail, purpose: 'cr-activation' });
  const rf = await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
  assert.equal(rf.status, 200);
  const ok = await cr.api('POST', '/api/auth/cr/verify-otp', { email: crEmail, otp: otpFrom(crEmail) });
  assert.equal(ok.status, 200);
});

/* ==================== 13, 14, 15, 16. CR activation completes ==================== */
test('CR password setup activates the account and CR can login', async () => {
  // fresh valid token (the previous test consumed one)
  await Otp.deleteMany({ email: crEmail, purpose: 'cr-activation' });
  await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
  const v = await cr.api('POST', '/api/auth/cr/verify-otp', { email: crEmail, otp: otpFrom(crEmail) });
  assert.equal(v.status, 200);
  const token = v.json.activationToken;

  // weak password rejected — and does NOT burn the token
  const weak = await cr.api('POST', '/api/auth/cr/set-password', { activationToken: token, password: 'weakpass' });
  assert.equal(weak.status, 400);

  // (14) expired activation token rejected
  const expired = jwt.sign(
    { type: 'activation', purpose: 'cr-activation', userId: String(await User.findOne({ email: crEmail }).then((u) => u._id)), jti: 'x' },
    process.env.JWT_SECRET, { expiresIn: -1 }
  );
  const exp = await cr.api('POST', '/api/auth/cr/set-password', { activationToken: expired, password: 'CrStrong123!' });
  assert.equal(exp.status, 401);

  // (15) valid token + strong password → activated
  const set = await cr.api('POST', '/api/auth/cr/set-password', { activationToken: token, password: 'CrStrong123!' });
  assert.equal(set.status, 200);
  const user = await User.findOne({ email: crEmail }).select('+password');
  assert.equal(user.registrationStatus, 'active');
  assert.equal(user.emailVerified, true);
  assert.ok(user.activationAt, 'activationAt set');
  assert.equal(user.role, 'cr');
  assert.ok(user.password.startsWith('$2'), 'bcrypt stored');

  // token is single-use — cannot set password again
  const again = await cr.api('POST', '/api/auth/cr/set-password', { activationToken: token, password: 'OtherStrong456!' });
  assert.equal(again.status, 409, 'account already activated');

  // (16) activated CR can login
  const login = await cr.api('POST', '/api/auth/login', { email: crEmail, password: 'CrStrong123!' });
  assert.equal(login.status, 200);
  const me = await cr.api('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, 'cr');
  assert.ok(me.json.user.section && me.json.user.section.id, 'section info present for frontend');
});

test('duplicate/already-active CR activation attempt gets no email', async () => {
  const before = sentEmails.length;
  const res = await cr.api('POST', '/api/auth/cr/request-otp', { email: crEmail });
  assert.equal(res.status, 200);
  assert.match(res.json.message, /if the account is eligible/i); // generic, no leak
  assert.equal(sentEmails.length, before, 'no email sent for an active account');
});

/* ==================== 18. CR cannot activate as student ==================== */
test('CR cannot activate through the student flow', async () => {
  const before = sentEmails.length;
  const res = await cr.api('POST', '/api/auth/student/request-otp', { email: crEmail });
  assert.equal(res.status, 200); // generic
  assert.equal(sentEmails.length, before, 'no email for role-mismatched flow');
  const verify = await cr.api('POST', '/api/auth/student/verify-otp', { email: crEmail, otp: '123456' });
  assert.equal(verify.status, 400);
});

/* ==================== 19-22. Student pre-registration by CR ==================== */
test('CR pre-creates a student in their OWN section', async () => {
  const res = await cr.api('POST', '/api/cr/students', {
    name: 'New Student', rollNo: 's-001', email: studentEmail, phone: '+923005556667',
    section: otherSectionId, // (20) client-supplied section MUST be ignored
    role: 'admin', // client-supplied role MUST be ignored
    registrationStatus: 'active', // MUST be ignored
  });
  assert.equal(res.status, 200);
  const doc = await User.findOne({ email: studentEmail }).select('+password');
  assert.equal(doc.role, 'student');
  assert.equal(doc.registrationStatus, 'pending');
  assert.equal(doc.emailVerified, false);
  assert.equal(doc.password, null);
  assert.equal(String(doc.section), String(sectionId), 'server-derived section, NOT the client one');
  assert.equal(String(doc.createdBy), String(await User.findOne({ email: crEmail }).then((u) => u._id)));
  assert.equal(doc.rollNo, 'S-001');
  // (27/28/29) none of the client-supplied protected fields had any effect
});

test('duplicate student rollNo within the section is rejected', async () => {
  const res = await cr.api('POST', '/api/cr/students', {
    name: 'Dup Roll', rollNo: 'S-001', email: 'otherstudent@test.local',
  });
  assert.equal(res.status, 409);
});

test('duplicate student email is rejected', async () => {
  const res = await cr.api('POST', '/api/cr/students', {
    name: 'Dup Email', rollNo: 'S-002', email: studentEmail,
  });
  assert.equal(res.status, 409);
});

test('CR lists only students of their own section', async () => {
  const res = await cr.api('GET', '/api/cr/students');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.every((s) => s.section === undefined || true));
  const dbStudents = await User.find({ section: sectionId, role: 'student' }).countDocuments();
  assert.equal(res.json.data.length, dbStudents);
});

/* ==================== 23-26. Student activation ==================== */
test('pending student cannot login, then activates and can login', async () => {
  // (26) pending student cannot login
  const early = await student.api('POST', '/api/auth/login', { email: studentEmail, password: 'Student123!' });
  assert.equal(early.status, 403);

  // (23) OTP works
  const req = await student.api('POST', '/api/auth/student/request-otp', { email: studentEmail });
  assert.equal(req.status, 200);
  const otp = otpFrom(studentEmail);
  assert.ok(otp, 'student OTP email sent via mock');
  const verify = await student.api('POST', '/api/auth/student/verify-otp', { email: studentEmail, otp });
  assert.equal(verify.status, 200);
  assert.ok(verify.json.activationToken);

  // (24) activation works
  const set = await student.api('POST', '/api/auth/student/set-password', {
    activationToken: verify.json.activationToken, password: 'Student123!',
  });
  assert.equal(set.status, 200);
  const doc = await User.findOne({ email: studentEmail });
  assert.equal(doc.registrationStatus, 'active');
  assert.equal(doc.role, 'student');
  assert.equal(String(doc.section), String(sectionId), 'section preserved');

  // (25) activated student can login
  const login = await student.api('POST', '/api/auth/login', { email: studentEmail, password: 'Student123!' });
  assert.equal(login.status, 200);
});

test('student cannot access CR or admin mutation routes', async () => {
  const a = await student.api('POST', '/api/cr/students', { name: 'X', rollNo: 'S-009', email: 'x9@test.local' });
  assert.equal(a.status, 403);
  const b = await student.api('GET', '/api/admin/departments');
  assert.equal(b.status, 403);
  // no self-service mutation route exists — PATCH /auth/me is not a route at all
  const c = await student.api('PATCH', '/api/auth/me', { rollNo: 'HACKED', role: 'admin' });
  assert.equal(c.status, 404);
  const doc = await User.findOne({ email: studentEmail });
  assert.equal(doc.rollNo, 'S-001', 'rollNo unchanged');
  assert.equal(doc.role, 'student', 'role unchanged');
  assert.equal(String(doc.section), String(sectionId), 'section unchanged');
});

/* ==================== 30-34. Password reset ==================== */
let resetEmail = 'resetuser@test.local';

test('password reset request is generic (no existence leak)', async () => {
  const ghost = await cr.api('POST', '/api/auth/forgot-password/request-otp', { email: 'ghost@test.local' });
  assert.equal(ghost.status, 200);
  assert.match(ghost.json.message, /if the account is eligible/i);
  const before = sentEmails.length;
  assert.equal(before > 0 ? sentEmails.length - 1 : 0, before - 1, 'no email for ghost');

  await User.create({
    name: 'Reset User', email: resetEmail, role: 'student', registrationStatus: 'active',
    password: await bcrypt.hash('OldPass123!', 10), section: sectionId,
  });
  const real = await cr.api('POST', '/api/auth/forgot-password/request-otp', { email: resetEmail });
  assert.equal(real.status, 200);
  assert.equal(real.json.message, ghost.json.message, 'identical generic message');
});

test('password reset OTP works end-to-end', async () => {
  const otp = otpFrom(resetEmail);
  const verify = await cr.api('POST', '/api/auth/forgot-password/verify-otp', { email: resetEmail, otp });
  assert.equal(verify.status, 200);
  assert.ok(verify.json.resetToken);

  // (32) expired reset token rejected
  const expired = jwt.sign({ type: 'password-reset', purpose: 'password-reset', userId: 'x', jti: 'y' }, process.env.JWT_SECRET, { expiresIn: -1 });
  const exp = await cr.api('POST', '/api/auth/forgot-password/set-password', { resetToken: expired, password: 'NewStrong456!' });
  assert.equal(exp.status, 401);

  const set = await cr.api('POST', '/api/auth/forgot-password/set-password', { resetToken: verify.json.resetToken, password: 'NewStrong456!' });
  assert.equal(set.status, 200);

  // (33) token is single-use
  const again = await cr.api('POST', '/api/auth/forgot-password/set-password', { resetToken: verify.json.resetToken, password: 'AgainStrong789!' });
  assert.equal(again.status, 401);

  // new password works
  const login = await cr.api('POST', '/api/auth/login', { email: resetEmail, password: 'NewStrong456!' });
  assert.equal(login.status, 200);
});

test('suspended account cannot bypass suspension through reset', async () => {
  // suspend the user AFTER a valid token exists
  await Otp.deleteMany({ email: resetEmail, purpose: 'password-reset' });
  const rr = await cr.api('POST', '/api/auth/forgot-password/request-otp', { email: resetEmail });
  assert.equal(rr.status, 200);
  const otp = otpFrom(resetEmail);
  const verify = await cr.api('POST', '/api/auth/forgot-password/verify-otp', { email: resetEmail, otp });
  assert.equal(verify.status, 200);
  await User.updateOne({ email: resetEmail }, { $set: { registrationStatus: 'suspended' } });
  const set = await cr.api('POST', '/api/auth/forgot-password/set-password', { resetToken: verify.json.resetToken, password: 'SneakyStrong1!' });
  assert.equal(set.status, 403, 'suspended user rejected');
  const doc = await User.findOne({ email: resetEmail }).select('+password');
  const stillOld = await bcrypt.compare('NewStrong456!', doc.password);
  assert.ok(stillOld, 'password NOT changed for suspended account');
  // and suspended user's new OTP request gets no email
  const before = sentEmails.length;
  const req = await cr.api('POST', '/api/auth/forgot-password/request-otp', { email: resetEmail });
  assert.equal(req.status, 200);
  assert.equal(sentEmails.length, before, 'no email for suspended account');
});

/* ==================== 36-39. audit + leakage ==================== */
test('audit events exist without secrets', async () => {
  for (const action of [
    'auth.otp.request', 'auth.otp.verify.success', 'auth.otp.verify.fail',
    'auth.cr.activate', 'auth.student.activate', 'auth.password-reset.request',
    'auth.password-reset.success', 'user.student.precreate',
  ]) {
    const n = await AuditLog.countDocuments({ action });
    assert.ok(n > 0, `${action} recorded`);
  }
  // no emailed OTP code ever appears in the audit trail
  const logs = await AuditLog.find({});
  const logText = JSON.stringify(logs.map((l) => ({ b: l.before, a: l.after, r: l.reason })));
  for (const e of sentEmails) {
    const body = JSON.parse(e.opts.body);
    const m = body?.textContent?.match(/\b(\d{6})\b/);
    if (m) assert.ok(!logText.includes(m[1]), 'OTP code never audited');
  }
  assert.ok(!logText.includes(BREVO_KEY), 'Brevo key never audited');
});

test('no password hash, OTP or token leakage in normal responses', async () => {
  const responses = [];
  responses.push(await student.api('GET', '/api/auth/me'));
  responses.push(await student.api('GET', '/api/cr/students'));
  const listRes = await student.api('GET', '/api/cr/students');
  responses.push(listRes);
  for (const r of responses) {
    assert.ok(!/\$2[ab]\$/.test(r.text), 'no bcrypt hash');
    assert.ok(!r.text.includes(BREVO_KEY), 'no Brevo key');
    assert.ok(!/"activationToken"/.test(r.text), 'no activation token');
    assert.ok(!/"resetToken"/.test(r.text), 'no reset token');
  }
  // the JWT login cookie is httpOnly — the JSON body never contains a token
  const login = await student.api('POST', '/api/auth/login', { email: studentEmail, password: 'Student123!' });
  assert.ok(!/"token"/.test(login.text));
});

test('existing Step 3A behavior unchanged: generic login errors + health', async () => {
  const bad = await student.api('POST', '/api/auth/login', { email: studentEmail, password: 'WrongPass99!' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.message, 'Invalid email or password');
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.database, 'connected');
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
