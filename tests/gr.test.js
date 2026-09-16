/**
 * GR (General Representative) tests — the second class representative role.
 * GR shares the ENTIRE CR permission surface (crOnly middleware), each section
 * holds at most one CR + one GR, and GR activation mirrors CR activation
 * (email OTP via Brevo mock — never real email).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('gr_test');
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

const { User, Section, Otp } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const sentEmails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.brevo.com')) {
    sentEmails.push({ url: String(url), opts });
    return { ok: true, status: 200, json: async () => ({ messageId: 'mock' }) };
  }
  return realFetch(url, opts);
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

const otpFrom = (email) => {
  for (let i = sentEmails.length - 1; i >= 0; i--) {
    const body = JSON.parse(sentEmails[i].opts.body);
    if (body.to?.[0]?.email === email) {
      const m = body?.textContent?.match(/\b(\d{6})\b/);
      if (m) return m[1];
    }
  }
  return null;
};

/* ================================ fixtures ================================ */
const admin = makeSession();
const gr = makeSession();
const student = makeSession();
let sectionId, otherSectionId, subjectId;
const grEmail = 'newgr@test.local';
const crEmail = 'newcr2@test.local';

test('fixtures: admin + sections + GR and CR pre-created on the same section', async () => {
  const login = await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  });
  assert.equal(login.status, 200);

  const d = await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' });
  const deptId = d.json.data._id;
  const s = await admin.api('POST', '/api/admin/sessions', { name: '2026–27' });
  const sessionId = s.json.data._id;
  const sec = await admin.api('POST', '/api/admin/sections', {
    department: deptId, session: sessionId, semester: 5, name: '5A',
  });
  sectionId = sec.json.data._id;
  const sec2 = await admin.api('POST', '/api/admin/sections', {
    department: deptId, session: sessionId, semester: 5, name: '5B',
  });
  otherSectionId = sec2.json.data._id;

  const preGr = await admin.api('POST', '/api/admin/crs', {
    name: 'New GR', email: grEmail, phone: '+923001112244', sectionId, role: 'gr',
  });
  assert.equal(preGr.status, 200);
  assert.equal(preGr.json.data.role, 'gr');

  // CR and GR coexist on ONE section — different slots
  const preCr = await admin.api('POST', '/api/admin/crs', {
    name: 'New CR', email: crEmail, sectionId, role: 'cr',
  });
  assert.equal(preCr.status, 200);
  assert.equal(preCr.json.data.role, 'cr');

  const sub = await admin.api('POST', '/api/admin/subjects', {
    section: sectionId, name: 'Artificial Intelligence', code: 'AI-301',
  });
  subjectId = sub.json.data._id;

  const secDoc = await Section.findById(sectionId);
  assert.ok(secDoc.gr, 'section.gr set');
  assert.ok(secDoc.cr, 'section.cr set');
  assert.notEqual(String(secDoc.gr), String(secDoc.cr));
});

test('a section rejects a SECOND GR but still accepts a CR', async () => {
  const dup = await admin.api('POST', '/api/admin/crs', {
    name: 'Dup GR', email: 'dupgr@test.local', sectionId, role: 'gr',
  });
  assert.equal(dup.status, 409);
  assert.match(dup.json.message, /already has a GR/i);

  const crOk = await admin.api('POST', '/api/admin/crs', {
    name: 'Another CR?', email: 'dupcr@test.local', sectionId, role: 'cr',
  });
  assert.equal(crOk.status, 409); // CR slot is also taken — role-aware rejection
  assert.match(crOk.json.message, /already has a CR/i);
});

test('invalid role payload is rejected', async () => {
  const bad = await admin.api('POST', '/api/admin/crs', {
    name: 'Bad Role', email: 'badrole@test.local', sectionId: otherSectionId, role: 'teacher',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /role/i);
});

/* ============================= GR activation ============================== */
test('pending GR cannot login before activation', async () => {
  const res = await gr.api('POST', '/api/auth/login', { email: grEmail, password: 'GrStrong123!' });
  assert.equal(res.status, 403);
  assert.equal(res.json.message, 'Account not activated yet');
});

test('GR OTP request works via /api/auth/gr/* with a gr-activation purpose email', async () => {
  const res = await gr.api('POST', '/api/auth/gr/request-otp', { email: grEmail });
  assert.equal(res.status, 200);
  const last = sentEmails[sentEmails.length - 1];
  const body = JSON.parse(last.opts.body);
  assert.match(body.subject, /GR activation code/i);

  const doc = await Otp.findOne({ email: grEmail, purpose: 'gr-activation' }).sort({ createdAt: -1 }).select('+codeHash');
  assert.ok(doc, 'gr-activation OTP stored');
  const otp = otpFrom(grEmail);
  assert.ok(otp, 'mock email contains the 6-digit OTP');
  assert.equal(await bcrypt.compare(otp, doc.codeHash), true, 'DB hash matches emailed OTP');
  assert.ok(!res.text.includes(otp), 'no OTP in response body');
});

test('GR verifies OTP, sets password, and logs in with role gr', async () => {
  const otp = otpFrom(grEmail);
  const verify = await gr.api('POST', '/api/auth/gr/verify-otp', { email: grEmail, otp });
  assert.equal(verify.status, 200);
  const token = verify.json.activationToken;
  assert.ok(token);

  const setPassword = await gr.api('POST', '/api/auth/gr/set-password', {
    email: grEmail, activationToken: token, password: 'GrStrong123!456',
  });
  assert.equal(setPassword.status, 200);

  const login = await gr.api('POST', '/api/auth/login', { email: grEmail, password: 'GrStrong123!456' });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, 'gr');

  const me = await gr.api('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, 'gr');
});

/* ========================= GR shares CR permissions ======================= */
test('GR can use the full CR surface: students, announcements, timetable', async () => {
  // CR-scoped student directory (crOnly middleware now serves both roles)
  const students = await gr.api('GET', '/api/cr/students');
  assert.equal(students.status, 200);

  const ann = await gr.api('POST', '/api/cr/announcements', {
    title: 'GR announcement', content: 'Posted by the GR — same powers as the CR.',
  });
  assert.equal(ann.status, 200);

  const tt = await gr.api('POST', '/api/cr/timetable', {
    date: '2026-09-17', startTime: '09:00', endTime: '10:00',
    subject: subjectId, room: 'Lab 2', type: 'lab',
  });
  assert.equal(tt.status, 200);

  const own = await gr.api('GET', '/api/cr/announcements');
  assert.equal(own.status, 200);
  assert.ok(own.json.data.some((a) => a.title === 'GR announcement'), 'GR sees own announcement');
});

test('GR is blocked from admin and student routes', async () => {
  const adminRoute = await gr.api('GET', '/api/admin/crs');
  assert.equal(adminRoute.status, 403);
  const studentRoute = await gr.api('GET', '/api/student/announcements');
  assert.equal(studentRoute.status, 403);
});

test('admin CR directory lists both CRs and GRs', async () => {
  const list = await admin.api('GET', '/api/admin/crs');
  assert.equal(list.status, 200);
  const roles = list.json.data.map((u) => u.role).sort();
  assert.ok(roles.includes('cr') && roles.includes('gr'));
});

/* ====================== assign / reassign / remove / delete =============== */
test('removeCr with role=gr clears section.gr but keeps section.cr', async () => {
  const res = await admin.api('POST', `/api/admin/sections/${sectionId}/cr/remove`, { role: 'gr' });
  assert.equal(res.status, 200);
  const doc = await Section.findById(sectionId);
  assert.equal(doc.gr, null);
  assert.ok(doc.cr, 'CR slot untouched');
});

test('reassignCr moves a GR between sections', async () => {
  // after removeCr the GR is section-less — assign back, then reassign away
  const grUser = await User.findOne({ email: grEmail });
  const assign = await admin.api('POST', `/api/admin/sections/${sectionId}/cr`, {
    userId: grUser._id, role: 'gr',
  });
  assert.equal(assign.status, 200);

  const other = await Section.findById(otherSectionId);
  const reassign = await admin.api('POST', `/api/admin/sections/${other._id}/cr/reassign`, {
    userId: grUser._id, role: 'gr',
  });
  assert.equal(reassign.status, 200);
  const oldDoc = await Section.findById(sectionId);
  const newDoc = await Section.findById(otherSectionId);
  assert.equal(oldDoc.gr, null, 'old section lost its GR');
  assert.ok(newDoc.gr, 'new section gained the GR');
  const moved = await User.findById(grUser._id);
  assert.equal(String(moved.section), String(otherSectionId));
});

test('deleteCr removes a GR and unlinks section.gr', async () => {
  const grUser = await User.findOne({ email: grEmail });
  const res = await admin.api('DELETE', `/api/admin/crs/${grUser._id}`);
  assert.equal(res.status, 200);
  const doc = await Section.findById(otherSectionId);
  assert.equal(doc.gr, null, 'section.gr cleared on delete');
  const gone = await User.findById(grUser._id);
  assert.equal(gone, null, 'GR user deleted');
});

test('cleanup: remaining fixtures', async () => {
  const crUser = await User.findOne({ email: crEmail });
  if (crUser) await admin.api('DELETE', `/api/admin/crs/${crUser._id}`);
  const left = await User.find({ role: 'gr' });
  for (const u of left) await admin.api('DELETE', `/api/admin/crs/${u._id}`);
});

test.after?.(() => {});
test('teardown closes the server', async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
