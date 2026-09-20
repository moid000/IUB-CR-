/**
 * Overview aggregate tests — the ONE-request dashboard endpoint
 * (GET /api/student/overview + GET /api/cr/overview).
 * Verifies: single round trip returns counts + recent lists, section
 * scoping holds, cross-portal tokens rejected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('overview_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Section } = models;
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
      return { status: res.status, json };
    },
  };
}

const admin = makeSession();
const crA = makeSession();   // section 5A
const crB = makeSession();   // section 5B
const studentA = makeSession();
const studentB = makeSession();

test('setup: dept/session/sections/CRs/students + sample content', async () => {
  await admin.api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'AdminPass123!456' });
  const dept = (await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const session = (await admin.api('POST', '/api/admin/sessions', { name: '2027–28' })).json.data._id;
  const secA = (await admin.api('POST', '/api/admin/sections', { department: dept, session, semester: 5, name: '5A' })).json.data._id;
  const secB = (await admin.api('POST', '/api/admin/sections', { department: dept, session, semester: 5, name: '5B' })).json.data._id;

  const hash = await bcrypt.hash('CrPass123!', 10);
  const mk = (name, email, phone, role, section, extra = {}) => User.create({
    name, email, phone, role, registrationStatus: 'active', emailVerified: true, password: hash, section, ...extra,
  });
  const crAId = (await mk('CR A', 'cr-a@test.local', '+923001110001', 'cr', secA, { status: 'active' }))._id;
  const crBId = (await mk('CR B', 'cr-b@test.local', '+923001110002', 'cr', secB, { status: 'active' }))._id;
  await mk('Student A1', 'student-a@test.local', '+923001110003', 'student', secA, { rollNo: 'R-001' });
  await mk('Student A2', 'student-a2@test.local', '+923001110004', 'student', secA, { rollNo: 'R-002' });
  await mk('Student B1', 'student-b@test.local', '+923001110005', 'student', secB, { rollNo: 'R-101' });
  await Section.updateOne({ _id: secA }, { $set: { cr: crAId } });
  await Section.updateOne({ _id: secB }, { $set: { cr: crBId } });

  await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' });
  await admin.api('POST', '/api/admin/subjects', { section: secB, name: 'Networking', code: 'NET-1' });

  // published announcement + assignment in section A only
  await admin.api('POST', '/api/admin/announcements', { section: secA, title: 'Welcome A', content: 'Hello section A' });
  await admin.api('POST', '/api/admin/assignments', {
    section: secA, subject: (await admin.api('GET', '/api/admin/subjects?section=' + secA)).json.data[0]._id,
    title: 'HW 1', deadline: new Date(Date.now() + 5 * 86400000).toISOString(),
  });

  for (const [s, email] of [[crA, 'cr-a@test.local'], [crB, 'cr-b@test.local'], [studentA, 'student-a@test.local'], [studentB, 'student-b@test.local']]) {
    assert.equal((await s.api('POST', '/api/auth/login', { email, password: 'CrPass123!' })).status, 200, email);
  }
});

/* ======================= STUDENT OVERVIEW ======================= */

test('student overview: one request returns counts + recent lists', async () => {
  const { status, json } = await studentA.api('GET', '/api/student/overview');
  assert.equal(status, 200);
  assert.ok(json.success);
  const d = json.data;
  assert.equal(typeof d.counts.subjects, 'number');
  assert.equal(typeof d.counts.assignments, 'number');
  assert.equal(typeof d.counts.attendance, 'number');
  assert.equal(typeof d.counts.unread, 'number');
  assert.ok(Array.isArray(d.announcements));
  assert.ok(Array.isArray(d.assignments));
  assert.ok(Array.isArray(d.todayClasses));
  // section-A student sees the section-A announcement, not section B's
  assert.ok(d.announcements.some((a) => a.title === 'Welcome A'));
  assert.ok(d.assignments.some((a) => a.title === 'HW 1'));
});

test('student overview: section scoping — B sees nothing from A', async () => {
  const { status, json } = await studentB.api('GET', '/api/student/overview');
  assert.equal(status, 200);
  const d = json.data;
  assert.equal(d.counts.subjects, 1); // B's own subject
  assert.ok(!d.announcements.some((a) => a.title === 'Welcome A'));
  assert.ok(!d.assignments.some((a) => a.title === 'HW 1'));
});

test('student overview: unauthenticated → 401, CR token → 403', async () => {
  assert.equal((await fetch(`${BASE}/api/student/overview`)).status, 401);
  assert.equal((await crA.api('GET', '/api/student/overview')).status, 403);
});

/* ======================= CR OVERVIEW ======================= */

test('cr overview: counts (incl. own students) + recent lists', async () => {
  const { status, json } = await crA.api('GET', '/api/cr/overview');
  assert.equal(status, 200);
  assert.ok(json.success);
  const d = json.data;
  assert.equal(d.counts.students, 2);       // A has 2 students, B has 1
  assert.equal(d.counts.subjects, 1);
  assert.equal(d.counts.assignments, 1);
  assert.ok(Array.isArray(d.announcements));
  assert.ok(d.announcements.some((a) => a.title === 'Welcome A'));
  assert.ok(Array.isArray(d.todayClasses));
});

test('cr overview: section scoping — CR B counts only B', async () => {
  const { status, json } = await crB.api('GET', '/api/cr/overview');
  assert.equal(status, 200);
  const d = json.data;
  assert.equal(d.counts.students, 1);
  assert.ok(!d.announcements.some((a) => a.title === 'Welcome A'));
});

test('cr overview: student token → 403', async () => {
  assert.equal((await studentA.api('GET', '/api/cr/overview')).status, 403);
});

test.after(async () => {
  // closeAllConnections essential: undici/fetch keep-alive sockets would keep
  // the process alive after tests (same pattern as push.test.js)
  server.closeAllConnections?.();
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
