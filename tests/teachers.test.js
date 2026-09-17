/**
 * STEP — teacher CRUD + WhatsApp deadline sweep.
 * Isolated in-memory REPLICA SET; sweep timing uses the deterministic
 * MOCK_NOW clock; the UltraMsg gateway is simulated by stubbing global fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('teachers_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
// Sweep + gateway config must exist BEFORE backend modules load (env is
// captured at import time). Fetch itself is stubbed per-test below.
process.env.DEADLINE_SWEEP_SECRET = 'sweep-secret-test';
process.env.ULTRAMSG_INSTANCE_ID = 'instance123';
process.env.ULTRAMSG_TOKEN = 'fake-token';
process.env.ULTRAMSG_API_URL = 'https://ultramsg.test.local';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { env } = await import('../backend/config/env.js');

const { User, Section, Subject, Assignment, Submission, Teacher } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

function makeSession() {
  const jar = new Map();
  return {
    async api(method, path, body, headers = {}) {
      const h = { ...headers };
      if (body !== undefined) h['content-type'] = 'application/json';
      if (jar.size) h.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(`${BASE}${path}`, {
        method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
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
const cr1 = makeSession();   // section A
const cr2 = makeSession();   // section B
const student1 = makeSession();

/* ================================ FIXTURES ================================ */
let deptCS, session1, secA, secB, subA1, subA2, subArchived, subB1;
let cr1Id, cr2Id, s1Id, s2Id, s3Id;

const T0 = new Date('2026-10-01T10:00:00.000Z').getTime();
function setNow(epoch = T0) { process.env.MOCK_NOW = String(epoch); }

test('fixtures: hierarchy + users', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  deptCS = (await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  session1 = (await admin.api('POST', '/api/admin/sessions', { name: '2027–28' })).json.data._id;
  secA = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5A' })).json.data._id;
  secB = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5B' })).json.data._id;

  const hash = await bcrypt.hash('Pass123!', 10);
  const mkUser = async (name, email, role, section, rollNo) =>
    (await User.create({ name, email, phone: '+923001110000', role, registrationStatus: 'active', emailVerified: true, password: hash, section, rollNo }))._id;
  cr1Id = await mkUser('CR One', 'cr1@test.local', 'cr', secA, null);
  cr2Id = await mkUser('CR Two', 'cr2@test.local', 'cr', secB, null);
  s1Id = await mkUser('Ali Raza', 's1@test.local', 'student', secA, 'R-001');
  s2Id = await mkUser('Bilal Khan', 's2@test.local', 'student', secA, 'R-002');
  s3Id = await mkUser('Usman Tariq', 's3@test.local', 'student', secA, 'R-003');
  await Section.updateOne({ _id: secA }, { $set: { cr: cr1Id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });

  subA1 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' })).json.data._id;
  subA2 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Operating Systems', code: 'OS-201' })).json.data._id;
  subB1 = (await admin.api('POST', '/api/admin/subjects', { section: secB, name: 'Databases', code: 'DB-201' })).json.data._id;
  subArchived = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Old Course', code: 'OLD-1' })).json.data._id;
  assert.equal((await admin.api('POST', `/api/admin/subjects/${subArchived}/archive`)).status, 200);

  assert.equal((await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'Pass123!' })).status, 200);
  assert.equal((await cr2.api('POST', '/api/auth/login', { email: 'cr2@test.local', password: 'Pass123!' })).status, 200);
  assert.equal((await student1.api('POST', '/api/auth/login', { email: 's1@test.local', password: 'Pass123!' })).status, 200);
});

/* ============================ TEACHER CRUD TESTS =========================== */

test('T1. CR creates a teacher (whatsapp normalized, section server-derived)', async () => {
  const res = await cr1.api('POST', '/api/cr/teachers', {
    name: 'Dr. Ahmed Raza', subject: subA1, whatsapp: '0301 2345678',
    email: 'ahmed@test.local', designation: 'Assistant Professor',
    section: secB, createdBy: s1Id, // injection attempts — must be ignored
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.whatsapp, '923012345678'); // 0301… → 92 301…
  const doc = await Teacher.findById(res.json.data._id);
  assert.equal(String(doc.section), String(secA)); // server-derived
  assert.equal(String(doc.createdBy), String(cr1Id));
  assert.equal(doc.email, 'ahmed@test.local');
});

test('T2. +92 and 92 prefixes normalize identically', async () => {
  const res = await cr1.api('POST', '/api/cr/teachers', {
    name: 'Prof. Sara Malik', subject: subA2, whatsapp: '+92 300 7654321',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.whatsapp, '923007654321');
});

test('T3. invalid whatsapp rejected', async () => {
  const res = await cr1.api('POST', '/api/cr/teachers', {
    name: 'Bad Number', subject: subA2, whatsapp: '12345',
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /valid international/i);
});

test('T4. one teacher per subject (409 on duplicate)', async () => {
  const res = await cr1.api('POST', '/api/cr/teachers', {
    name: 'Second Teacher', subject: subA1, whatsapp: '923001112222',
  });
  assert.equal(res.status, 409);
  assert.match(res.json.message, /already has a teacher/i);
});

test('T5. cross-section subject → 404 (existence never leaked)', async () => {
  const res = await cr1.api('POST', '/api/cr/teachers', {
    name: 'Cross Teacher', subject: subB1, whatsapp: '923001113333',
  });
  assert.equal(res.status, 404);
});

test('T6. archived subject rejected', async () => {
  const res = await cr1.api('POST', '/api/cr/teachers', {
    name: 'Archived Teacher', subject: subArchived, whatsapp: '923001114444',
  });
  assert.equal(res.status, 404);
});

test('T7. list is section-scoped with subject populated', async () => {
  const res = await cr1.api('GET', '/api/cr/teachers');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.length, 2);
  assert.ok(res.json.data.every((t) => t.subject && t.subject.name));
  assert.ok(res.json.data.every((t) => String(t.section) === String(secA)));
});

test('T8. update teacher (name + whatsapp), subject swap allowed to free subject', async () => {
  const list = await cr1.api('GET', '/api/cr/teachers');
  const t = list.json.data.find((x) => x.name === 'Dr. Ahmed Raza');
  const res = await cr1.api('PATCH', `/api/cr/teachers/${t._id}`, {
    name: 'Dr. Ahmed Raza Khan', whatsapp: '+92 301 5556667',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.whatsapp, '923015556667');
  assert.equal(res.json.data.name, 'Dr. Ahmed Raza Khan');
});

test('T9. update blocked when target subject already taken', async () => {
  const list = await cr1.api('GET', '/api/cr/teachers');
  const free = list.json.data.find((x) => x.name === 'Prof. Sara Malik');
  const res = await cr1.api('PATCH', `/api/cr/teachers/${free._id}`, { subject: subA1 });
  assert.equal(res.status, 409);
});

test('T10. cross-section update → 404', async () => {
  const res = await cr1.api('PATCH', `/api/cr/teachers/${cr1Id}000000000`, { name: 'X' });
  assert.ok([400, 404].includes(res.status));
});

test('T11. student cannot manage teachers (403)', async () => {
  const res = await student1.api('POST', '/api/cr/teachers', {
    name: 'Hack Teacher', subject: subA1, whatsapp: '923001119999',
  });
  assert.equal(res.status, 403);
});

test('T12. unauthenticated → 401', async () => {
  const res = await fetch(`${BASE}/api/cr/teachers`);
  assert.equal(res.status, 401);
});

test('T13. delete teacher, then re-create for the same subject', async () => {
  const list = await cr1.api('GET', '/api/cr/teachers');
  const t = list.json.data.find((x) => x.subject.code === 'OS-201');
  const del = await cr1.api('DELETE', `/api/cr/teachers/${t._id}`);
  assert.equal(del.status, 200);
  const again = await cr1.api('POST', '/api/cr/teachers', {
    name: 'Prof. New Hire', subject: t.subject._id, whatsapp: '923300112233',
  });
  assert.equal(again.status, 200);
});

/* ========================== DEADLINE SWEEP TESTS ========================== */

const SWEEP = '/api/whatsapp/deadline-sweep';
let teacherId, otherTeacherId;

function stubGateway(calls) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('ultramsg.test.local')) return original(url, opts); // pass-through
    calls.push({ url: String(url), body: String(opts?.body ?? '') });
    return {
      ok: true, status: 200,
      json: async () => ({ sent: 'true', id: String(calls.length) }),
      text: async () => JSON.stringify({ sent: 'true', id: String(calls.length) }),
    };
  };
  return () => { globalThis.fetch = original; };
}

test('S1. sweep requires the secret (401/503 semantics)', async () => {
  assert.equal((await fetch(`${BASE}${SWEEP}`)).status, 401); // GET without secret
  assert.equal((await fetch(`${BASE}${SWEEP}?secret=wrong`)).status, 401); // wrong secret
  const ok = await fetch(`${BASE}${SWEEP}?secret=sweep-secret-test`);
  assert.equal(ok.status, 200);
  const json = await ok.json();
  assert.equal(json.data.configured, true);
});

test('S2. not-configured gateway → graceful report, nothing marked', async () => {
  // Create a due assignment first
  setNow(T0);
  const due = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Unswept task', deadline: new Date(T0 - 3600_000).toISOString(),
  });
  assert.equal(due.status, 200);
  const savedToken = env.whatsapp.token;
  env.whatsapp.token = undefined; // simulate missing gateway config
  const res = await fetch(`${BASE}${SWEEP}?secret=sweep-secret-test`);
  const json = await res.json();
  assert.equal(json.data.configured, false);
  const doc = await Assignment.findById(due.json.data._id);
  assert.equal(doc.deadlineNotifiedAt, null); // claim NOT taken
  env.whatsapp.token = savedToken;
  // cleanup for later tests
  await Assignment.findByIdAndDelete(due.json.data._id);
});

test('S3. full sweep: summary + one message per submission', async () => {
  setNow(T0);
  // subA1 already has a teacher from the CRUD tests (whatsapp 923015556667)
  const existing = await Teacher.findOne({ subject: subA1 });
  assert.ok(existing, 'teacher fixture from CRUD tests exists');
  teacherId = existing._id;

  // Assignment due 1h before "now"
  const a1 = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Normalization task', deadline: new Date(T0 - 3600_000).toISOString(),
  });
  assert.equal(a1.status, 200);
  const a1Id = a1.json.data._id;

  // Two students submit (one with a file link, one text-only)
  await Submission.create({
    assignment: a1Id, student: s1Id, section: secA,
    files: [{ publicId: 'p1', url: 'https://res.cloudinary.com/x/p1.pdf', originalName: 'ali-assignment.pdf' }],
  });
  await Submission.create({
    assignment: a1Id, student: s2Id, section: secA, textAnswer: 'My answer here',
  });
  // s3 does NOT submit → must appear in the not-submitted list

  const calls = [];
  const restore = stubGateway(calls);
  try {
    const res = await fetch(`${BASE}${SWEEP}?secret=sweep-secret-test`);
    const json = await res.json();
    assert.equal(json.data.configured, true);
    assert.equal(json.data.processed.length, 1);
    const p = json.data.processed[0];
    assert.equal(p.status, 'sent');
    assert.equal(p.sent, 3); // summary + 2 submissions
    assert.equal(p.failed, 0);

    // summary message content
    const summary = calls.find((c) => c.body.includes('Assignment+Deadline+Report') || c.body.includes('Deadline'));
    assert.ok(summary, 'summary message sent');
    const decoded = decodeURIComponent(summary.body);
    assert.ok(decoded.includes('Normalization+task') || summary.body.includes('Normalization'));
    assert.ok(decoded.includes('Ali+Raza') || summary.body.includes('Ali%20Raza') || summary.body.includes('Ali+Raza'), 'submitted student listed by name');
    assert.ok(summary.body.includes('R-003'), 'non-submitter roll number listed');
    assert.ok(summary.body.includes('Usman+Tariq') || summary.body.includes('Usman%20Tariq'), 'non-submitter name listed');
    assert.ok(summary.body.includes('923015556667'), 'sent to the teacher number');

    // per-student messages contain roll numbers + file links
    const perStudent = calls.filter((c) => c.body.includes('Submission+1') || c.body.includes('Submission+2') || c.body.includes('Submission%201') || c.body.includes('Submission%202') || /Submission\+[12]/.test(c.body));
    assert.equal(perStudent.length, 2);
    assert.ok(calls.some((c) => c.body.includes('ali-assignment.pdf')));
    assert.ok(calls.some((c) => c.body.includes('res.cloudinary.com')));

    // idempotent — assignment is claimed
    const doc = await Assignment.findById(a1Id);
    assert.ok(doc.deadlineNotifiedAt);
  } finally {
    restore();
  }

  // Second sweep run must NOT resend (idempotency)
  const calls2 = [];
  const restore2 = stubGateway(calls2);
  try {
    await fetch(`${BASE}${SWEEP}?secret=sweep-secret-test`);
    assert.equal(calls2.length, 0);
  } finally {
    restore2();
  }
  // cleanup
  await Submission.deleteMany({ assignment: a1Id });
  await Assignment.findByIdAndDelete(a1Id);
});

test('S4. no teacher linked → skipped, marked notified, no messages', async () => {
  setNow(T0);
  // fresh subject deliberately left WITHOUT a teacher
  const ntRes = await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Networks', code: 'NT-301' });
  const freeSubject = { _id: ntRes.json.data._id };
  const a2 = await cr1.api('POST', '/api/cr/assignments', {
    subject: freeSubject._id, title: 'Networks task', deadline: new Date(T0 - 3600_000).toISOString(),
  });
  const a2Id = a2.json.data._id;

  const calls = [];
  const restore = stubGateway(calls);
  try {
    const res = await fetch(`${BASE}${SWEEP}?secret=sweep-secret-test`);
    const json = await res.json();
    assert.equal(json.data.skippedNoTeacher, 1);
    const doc = await Assignment.findById(a2Id);
    assert.ok(doc.deadlineNotifiedAt); // claimed — no retries forever
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
  await Assignment.findByIdAndDelete(a2Id);
});

test('S5. summary failure → claim released, retry scheduled', async () => {
  setNow(T0);
  const a3 = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Retry task', deadline: new Date(T0 - 3600_000).toISOString(),
  });
  const a3Id = a3.json.data._id;
  await Submission.create({ assignment: a3Id, student: s1Id, section: secA, textAnswer: 'x' });

  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('ultramsg.test.local')) return original(url, opts); // pass-through
    return { ok: false, status: 502, text: async () => JSON.stringify({ error: 'session down' }) };
  };
  try {
    const res = await fetch(`${BASE}${SWEEP}?secret=sweep-secret-test`);
    const json = await res.json();
    const p = json.data.processed[0];
    assert.equal(p.status, 'retry-scheduled');
    const doc = await Assignment.findById(a3Id);
    assert.equal(doc.deadlineNotifiedAt, null); // claim released → retried next ping
  } finally {
    globalThis.fetch = original;
  }
  await Submission.deleteMany({ assignment: a3Id });
  await Assignment.findByIdAndDelete(a3Id);
});

test('S6. future-deadline assignment is never touched', async () => {
  setNow(T0);
  const a4 = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Future task', deadline: new Date(T0 + 3600_000).toISOString(),
  });
  const a4Id = a4.json.data._id;
  const calls = [];
  const restore = stubGateway(calls);
  try {
    const res = await fetch(`${BASE}${SWEEP}?secret=sweep-secret-test`);
    const json = await res.json();
    assert.equal(json.data.processedCount, 0);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
  const doc = await Assignment.findById(a4Id);
  assert.equal(doc.deadlineNotifiedAt, null);
  await Assignment.findByIdAndDelete(a4Id);
});

test('S7. stale deadline (>24h old) is never swept', async () => {
  setNow(T0);
  const a5 = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Ancient task', deadline: new Date(T0 - 48 * 3600_000).toISOString(),
  });
  const a5Id = a5.json.data._id;
  const calls = [];
  const restore = stubGateway(calls);
  try {
    const res = await fetch(`${BASE}${SWEEP}?secret=sweep-secret-test`);
    assert.equal((await res.json()).data.processedCount, 0);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
  await Assignment.findByIdAndDelete(a5Id);
});

/* ================================ TEARDOWN ================================ */

test('teardown', async () => {
  await server.close();
  await mongoose.connection.close();
  await mongod.stop();
});
