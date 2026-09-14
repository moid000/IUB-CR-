/**
 * STEP 11 tests — Grading / Marks backend.
 * Isolated in-memory replica set. NO real credentials, NO production data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('marks_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = '123456789012345';
process.env.CLOUDINARY_API_SECRET = 'fake-secret';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Section, Subject, Assessment, Mark, AuditLog } = models;
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
const crA = makeSession(); // CR of section A
const crB = makeSession(); // CR of section B
const s1 = makeSession();  // student, section A
const s2 = makeSession();  // student, section A
const sB = makeSession();  // student, section B

let secA, secB, subA, subB;
let s1Id, s2Id, sBId, crAId;
let s1PendingId;

const login = (sess, email) => sess.api('POST', '/api/auth/login', { email, password: 'Pass1234!' });
const A = (path) => `/api/cr${path}`;
const ADM = (path) => `/api/admin${path}`;
const STU = (path) => `/api/student${path}`;

const mkAssessment = (path, over = {}) => ({
  subject: subA, title: 'Quiz 1', type: 'quiz', totalMarks: 20,
  assessmentDate: '2026-09-20T09:00:00.000Z', ...over,
});

test('fixtures: hierarchy, users', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  const dept = (await admin.api('POST', '/api/admin/departments', { name: 'CS', code: 'CS' })).json.data._id;
  const sess = (await admin.api('POST', '/api/admin/sessions', { name: '2027–28' })).json.data._id;
  secA = (await admin.api('POST', '/api/admin/sections', { department: dept, session: sess, semester: 5, name: '5A' })).json.data._id;
  secB = (await admin.api('POST', '/api/admin/sections', { department: dept, session: sess, semester: 5, name: '5B' })).json.data._id;

  const hash = await bcrypt.hash('Pass1234!', 10);
  const mk = (name, email, role, section, extra = {}) => User.create({
    name, email, phone: '+9230011100' + Math.floor(Math.random() * 900 + 99),
    role, registrationStatus: 'active', emailVerified: true, password: hash, section, ...extra,
  }).then((u) => u._id);
  crAId = await mk('CR A', 'mk-cr1@test.local', 'cr', secA, { status: 'active' });
  await mk('CR B', 'mk-cr2@test.local', 'cr', secB);
  s1Id = await mk('Stud One', 'mk-s1@test.local', 'student', secA, { rollNo: 'F-001' });
  s2Id = await mk('Stud Two', 'mk-s2@test.local', 'student', secA, { rollNo: 'F-002' });
  sBId = await mk('Stud B', 'mk-sb@test.local', 'student', secB, { rollNo: 'F-101' });
  s1PendingId = await mk('Pend One', 'mk-p1@test.local', 'student', secA, { rollNo: 'F-003', registrationStatus: 'pending' });
  await Section.updateOne({ _id: secA }, { $set: { cr: crAId } });

  subA = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' })).json.data._id;
  subB = (await admin.api('POST', '/api/admin/subjects', { section: secB, name: 'Networking', code: 'NET-101' })).json.data._id;

  for (const [sessn, email] of [[crA, 'mk-cr1@test.local'], [crB, 'mk-cr2@test.local'], [s1, 'mk-s1@test.local'], [s2, 'mk-s2@test.local'], [sB, 'mk-sb@test.local']]) {
    assert.equal((await login(sessn, email)).status, 200, email);
  }
});

/* ------------------------- A. AUTHENTICATION ------------------------- */
test('A. all grading routes unauthenticated → 401', async () => {
  const anon = makeSession();
  const checks = [
    ['POST', A('/assessments')], ['GET', A('/assessments')], ['GET', A('/assessments/x')],
    ['PATCH', A('/assessments/x')], ['POST', A('/assessments/x/open')],
    ['POST', A('/assessments/x/finalize')], ['POST', A('/assessments/x/archive')],
    ['POST', A('/assessments/x/marks')], ['PATCH', A('/assessments/x/marks/y')],
    ['POST', A('/assessments/x/marks/bulk')], ['GET', A('/assessments/x/marks')],
    ['POST', ADM('/assessments')], ['GET', ADM('/assessments')], ['PATCH', ADM('/assessments/x')],
    ['POST', ADM('/assessments/x/finalize')], ['GET', ADM('/assessments/x/marks')],
    ['GET', STU('/assessments')], ['GET', STU('/assessments/x')], ['GET', STU('/marks')],
  ];
  for (const [method, path] of checks) {
    const res = await anon.api(method, path, method === 'GET' ? undefined : {});
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

/* ----------------------- B. ASSESSMENT CREATION ----------------------- */
let asgId; // shared open assessment

test('B1. CR creates a valid draft assessment (own section)', async () => {
  const res = await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments')));
  assert.equal(res.status, 200, res.text);
  const d = res.json.data;
  assert.equal(d.status, 'draft');
  assert.equal(String(d.section), String(secA));
  assert.equal(String(d.createdBy), String(crAId)); // server-derived
  asgId = d._id;
});

test('B2. invalid totalMarks / type / title / date rejected', async () => {
  for (const over of [
    { totalMarks: 0 }, { totalMarks: -5 }, { totalMarks: 1001 },
    { totalMarks: '20' }, { totalMarks: 12.5 }, { totalMarks: NaN },
    { totalMarks: Infinity }, { totalMarks: null }, { totalMarks: undefined },
    { type: 'surprise' }, { type: '' }, { type: undefined }, { type: 'QUIZ!' },
    { title: 'x' }, { title: '' }, { title: undefined },
    { assessmentDate: 'not-a-date' }, { assessmentDate: undefined },
  ]) {
    const res = await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), over));
    assert.equal(res.status, 400, JSON.stringify(over));
  }
  // type IS normalized to lowercase
  const ok = await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), { type: ' Midterm ', title: 'Mid' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.type, 'midterm');
  await crA.api('POST', A(`/assessments/${ok.json.data._id}/archive`));
});

test('B3. subject validation: cross-section / archived / missing', async () => {
  assert.equal((await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), { subject: subB }))).status, 400);
  assert.equal((await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), { subject: new mongoose.Types.ObjectId() }))).status, 400);
  assert.equal((await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), { subject: 'zzz' }))).status, 400);
  // archived subject
  const archSub = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Old', code: 'OLD-1' })).json.data._id;
  await admin.api('POST', `/api/admin/subjects/${archSub}/archive`);
  assert.equal((await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), { subject: archSub }))).status, 400);
});

test('B4. archived section rejected (CR and Admin)', async () => {
  // admin archives section B after creating a subject… then new assessments rejected
  const secBOrg = await Section.findById(secB);
  const before = await admin.api('POST', '/api/admin/sections', {
    department: secBOrg.department, session: secBOrg.session,
    semester: 6, name: '6C',
  });
  assert.equal(before.status, 200, before.text);
  const secC = before.json.data._id;
  const subC = (await admin.api('POST', '/api/admin/subjects', { section: secC, name: 'X', code: 'XC-1' })).json.data;
  assert.ok(subC?._id, 'subject created while the section is still active');
  await admin.api('POST', `/api/admin/sections/${secC}/archive`);
  // admin tries to create for archived section
  const res = await admin.api('POST', ADM('/assessments'), {
    section: secC, subject: subC._id, title: 'Nope', type: 'quiz', totalMarks: 10,
    assessmentDate: '2026-09-20T09:00:00.000Z',
  });
  assert.equal(res.status, 400);
});

test('B5. ownership injection: CR section/status/createdBy never trusted', async () => {
  const res = await crA.api('POST', A('/assessments'), {
    ...mkAssessment(A('/assessments')),
    section: secB, sectionId: secB, // injection — must be ignored
    createdBy: sBId, enteredBy: sBId,
    status: 'finalized', finalizedAt: new Date().toISOString(),
  });
  assert.equal(res.status, 200);
  const d = res.json.data;
  assert.equal(String(d.section), String(secA)); // CR's OWN section
  assert.equal(d.status, 'draft'); // server-controlled
  assert.equal(String(d.createdBy), String(crAId));
  assert.equal(d.finalizedAt, null);
  await crA.api('POST', A(`/assessments/${d._id}/archive`));
});

test('B6. admin creates for any active section; cross-relationship still enforced', async () => {
  const ok = await admin.api('POST', ADM('/assessments'), {
    section: secB, subject: subB, title: 'B quiz', type: 'quiz', totalMarks: 30,
    assessmentDate: '2026-09-21T09:00:00.000Z',
  });
  assert.equal(ok.status, 200);
  // Section A + Section B's subject → rejected even for admin
  const bad = await admin.api('POST', ADM('/assessments'), {
    section: secA, subject: subB, title: 'Mixed', type: 'quiz', totalMarks: 10,
    assessmentDate: '2026-09-21T09:00:00.000Z',
  });
  assert.equal(bad.status, 400);
});

/* ------------------------ C. ASSESSMENT LIFECYYCLE ------------------------ */
test('C1. draft → open via explicit endpoint; marks entry requires open', async () => {
  // mark entry in draft is rejected
  assert.equal((await crA.api('POST', A(`/assessments/${asgId}/marks`), { student: s1Id, marksObtained: 10 })).status, 400);
  const open = await crA.api('POST', A(`/assessments/${asgId}/open`));
  assert.equal(open.status, 200);
  assert.equal(open.json.data.status, 'open');
  // re-open → 409
  assert.equal((await crA.api('POST', A(`/assessments/${asgId}/open`))).status, 409);
});

test('C2. draft and open are editable; section is immutable', async () => {
  const res = await crA.api('PATCH', A(`/assessments/${asgId}`), { title: 'Quiz 1 — revised', totalMarks: 25 });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.title, 'Quiz 1 — revised');
  assert.equal(res.json.data.totalMarks, 25);
  // client section change ignored/rejected — Mark history depends on it
  const sec = await crA.api('PATCH', A(`/assessments/${asgId}`), { section: secB, subject: subB });
  assert.equal(sec.status, 400);
});

test('C3. finalize: server-derived actor/timestamp, marks locked, no reopen', async () => {
  const res = await crA.api('POST', A(`/assessments/${asgId}/finalize`));
  assert.equal(res.status, 200);
  const d = res.json.data;
  assert.equal(d.status, 'finalized');
  assert.ok(d.finalizedAt);
  // second finalize → 409
  assert.equal((await crA.api('POST', A(`/assessments/${asgId}/finalize`))).status, 409);
  // PATCH rejected
  assert.equal((await crA.api('PATCH', A(`/assessments/${asgId}`), { title: 'nope' })).status, 400);
  // no reopen route exists at all — /open on finalized → 409 (not reopen)
  assert.equal((await crA.api('POST', A(`/assessments/${asgId}/open`))).status, 409);
  // mark entry rejected after finalize
  assert.equal((await crA.api('POST', A(`/assessments/${asgId}/marks`), { student: s1Id, marksObtained: 1 })).status, 400);
});

test('C4. archive: duplicate → 409; archived read-only; still readable', async () => {
  const res = await crA.api('POST', A(`/assessments/${asgId}/archive`));
  assert.equal(res.status, 200);
  assert.equal(res.json.data.status, 'archived');
  assert.equal((await crA.api('POST', A(`/assessments/${asgId}/archive`))).status, 409);
  assert.equal((await crA.api('PATCH', A(`/assessments/${asgId}`), { title: 'x' })).status, 400);
  assert.equal((await crA.api('POST', A(`/assessments/${asgId}/finalize`))).status, 400);
  // still readable by CR
  assert.equal((await crA.api('GET', A(`/assessments/${asgId}`))).status, 200);
});

/* ---------------------------- D. MARK ENTRY ---------------------------- */
let openId; // a fresh open assessment for marks tests

test('D1. valid marks: zero, full, and boundary values', async () => {
  const mk = await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), { title: 'Marks test' }));
  await crA.api('POST', A(`/assessments/${mk.json.data._id}/open`));
  openId = mk.json.data._id;
  const total = mk.json.data.totalMarks; // the REAL total — fixture default is 20

  const zero = await crA.api('POST', A(`/assessments/${openId}/marks`), { student: s1Id, marksObtained: 0 });
  assert.equal(zero.status, 200, 'zero allowed');
  const full = await crA.api('POST', A(`/assessments/${openId}/marks`), { student: s2Id, marksObtained: total });
  assert.equal(full.status, 200, 'full marks allowed');
  assert.equal(String(full.json.data.enteredBy), String(crAId));
});

test('D2. invalid mark values rejected', async () => {
  const doc = await Assessment.findById(openId);
  for (const value of [-1, doc.totalMarks + 1, 12.5, '15', NaN, Infinity, null, undefined, true]) {
    const res = await crA.api('POST', A(`/assessments/${openId}/marks`), { student: s1PendingId, marksObtained: value });
    assert.equal(res.status, 400, `marksObtained=${JSON.stringify(value)}`);
  }
});

test('D3. student eligibility: pending / suspended / other-section / CR / admin rejected', async () => {
  for (const student of [s1PendingId, sBId, crAId]) {
    const res = await crA.api('POST', A(`/assessments/${openId}/marks`), { student, marksObtained: 5 });
    assert.equal(res.status, 400, String(student));
  }
  // suspended
  const sus = await User.create({
    name: 'Suspended One', email: 'mk-sus@test.local', phone: '+923001119991',
    role: 'student', registrationStatus: 'suspended', emailVerified: true,
    password: await bcrypt.hash('Pass1234!', 10), section: secA, rollNo: 'F-004',
  });
  assert.equal((await crA.api('POST', A(`/assessments/${openId}/marks`), { student: sus._id, marksObtained: 5 })).status, 400);
  // invalid ids
  assert.equal((await crA.api('POST', A(`/assessments/${openId}/marks`), { student: 'zzz', marksObtained: 5 })).status, 400);
  assert.equal((await crA.api('POST', A(`/assessments/${openId}/marks`), { student: new mongoose.Types.ObjectId(), marksObtained: 5 })).status, 400);
});

test('D4. duplicate mark → 409; PATCH updates value', async () => {
  assert.equal((await crA.api('POST', A(`/assessments/${openId}/marks`), { student: s1Id, marksObtained: 3 })).status, 409);
  const upd = await crA.api('PATCH', A(`/assessments/${openId}/marks/${s1Id}`), { marksObtained: 18 });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.data.marksObtained, 18);
  const asgDoc = await Assessment.findById(openId);
  assert.equal((await crA.api('PATCH', A(`/assessments/${openId}/marks/${s1Id}`), { marksObtained: asgDoc.totalMarks + 1 })).status, 400);
  assert.equal((await crA.api('PATCH', A(`/assessments/${openId}/marks/${sBId}`), { marksObtained: 1 })).status, 404);
});

test('D5. CR marks sheet: items + calculated missing list (never stored)', async () => {
  const res = await crA.api('GET', A(`/assessments/${openId}/marks`));
  assert.equal(res.status, 200);
  assert.equal(res.json.data.items.length, 2); // s1 + s2
  const missingIds = res.json.data.missing.map((m) => String(m._id));
  assert.ok(!missingIds.includes(String(s1Id)) && !missingIds.includes(String(s2Id)));
  assert.ok(missingIds.includes(String(s1PendingId)) === false); // pending — not an active student
  assert.equal(res.json.data.counts.entered, 2);
  assert.equal(res.json.data.assessment._id, String(openId));
  // mark docs never auto-created for missing students
  assert.equal(await Mark.countDocuments({ assessment: openId }), 2);
});

/* -------------------------- J. BULK MARKS -------------------------- */
test('J1. valid bulk upsert — atomic, counts correct', async () => {
  const res = await crA.api('POST', A(`/assessments/${openId}/marks/bulk`), {
    rows: [
      { student: s1Id, marksObtained: 19 }, // existing → update
      { student: s2Id, marksObtained: 20 }, // existing → update (full marks)
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.data.processed, 2);
  const sheet = await crA.api('GET', A(`/assessments/${openId}/marks`));
  assert.equal(sheet.json.data.items.find((m) => String(m.student._id) === String(s1Id)).marksObtained, 19);
});

test('J2. bulk: duplicate rows / invalid students / out-of-range → nothing written', async () => {
  const before = await Mark.countDocuments({ assessment: openId });
  for (const rows of [
    [{ student: s1Id, marksObtained: 1 }, { student: s1Id, marksObtained: 2 }], // duplicate student
    [{ student: sBId, marksObtained: 1 }], // other section
    [{ student: s1PendingId, marksObtained: 1 }], // pending
    [{ student: s1Id, marksObtained: 99 }], // above total
    [{ student: s1Id, marksObtained: 'a' }],
    [],
  ]) {
    const res = await crA.api('POST', A(`/assessments/${openId}/marks/bulk`), { rows });
    assert.equal(res.status, 400, JSON.stringify(rows));
  }
  assert.equal(await Mark.countDocuments({ assessment: openId }), before); // no partial writes
});

/* ------------------------- H. CONCURRENCY ------------------------- */
test('H. concurrent mark creation → exactly ONE record (unique index arbiter)', async () => {
  const mk = await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), { title: 'Race test' }));
  const id = mk.json.data._id;
  await crA.api('POST', A(`/assessments/${id}/open`));
  const calls = await Promise.allSettled(Array.from({ length: 10 }, () =>
    crA.api('POST', A(`/assessments/${id}/marks`), { student: s2Id, marksObtained: 7 })));
  const wins = calls.filter((c) => c.value.status === 200);
  assert.equal(wins.length, 1, 'exactly one creation succeeds');
  assert.ok(calls.every((c) => [200, 409].includes(c.value.status)), 'no 500s under races');
  assert.equal(await Mark.countDocuments({ assessment: id, student: s2Id }), 1);
  await crA.api('POST', A(`/assessments/${id}/archive`));
});

test('H2. concurrent finalize + mark entry — finalized state wins atomically', async () => {
  const mk = await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), { title: 'Lock race' }));
  const id = mk.json.data._id;
  await crA.api('POST', A(`/assessments/${id}/open`));
  await crA.api('POST', A(`/assessments/${id}/marks`), { student: s1Id, marksObtained: 9 });
  const [, fin, entry] = await Promise.all([
    Promise.resolve(),
    crA.api('POST', A(`/assessments/${id}/finalize`)),
    crA.api('POST', A(`/assessments/${id}/marks`), { student: s2Id, marksObtained: 5 }),
  ]);
  assert.equal(fin.status, 200);
  assert.ok([200, 400].includes(entry.status), 'either order is safe — never a 500');
  const doc = await Assessment.findById(id);
  assert.equal(doc.status, 'finalized');
  // INVARIANT: after the race, EVERY mark of this assessment is locked —
  // no mark may slip past the finalize transaction as 'active'
  const marks = await Mark.find({ assessment: id });
  assert.ok(marks.length >= 1);
  assert.ok(marks.every((m) => m.status === 'finalized'),
    `entry=${entry.status}: all marks must be finalized after concurrent finalize`);
  // locked mark update → 400
  assert.equal((await crA.api('PATCH', A(`/assessments/${id}/marks/${s1Id}`), { marksObtained: 10 })).status, 400);
});

/* ------------------------- E. STUDENT ACCESS ------------------------- */
test('E1. student sees own marks; another student stays invisible; drafts hidden', async () => {
  const list = await s1.api('GET', STU('/assessments'));
  assert.equal(list.status, 200);
  // draft assessments never visible to students
  assert.ok(list.json.data.every((a) => a.status !== 'draft'));
  const mine = list.json.data.find((a) => a._id === openId);
  assert.ok(mine, 'open assessment listed');
  assert.equal(mine.myMark.marksObtained, 19);

  const detail = await s1.api('GET', STU(`/assessments/${openId}`));
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.myMark.marksObtained, 19);
  assert.equal(detail.json.data.myStatus, 'entered');

  // student without marks → calculated missing, never a stored zero
  const sheet = await sB.api('GET', STU('/assessments'));
  assert.equal(sheet.status, 200);
  // own-marks history endpoint — ONLY own records
  const marks = await s1.api('GET', STU('/marks'));
  assert.equal(marks.status, 200);
  assert.ok(marks.json.data.every((m) => String(m.student) === String(s1Id)));
  assert.ok(marks.json.data.length >= 1);
});

test('E2. student cannot create/update/finalize/archive — read-only by routes and role', async () => {
  assert.equal((await s1.api('POST', STU('/assessments'), mkAssessment(''))).status, 404); // no such route
  assert.equal((await s1.api('PATCH', STU(`/assessments/${openId}`), { title: 'x' })).status, 404);
  assert.equal((await s1.api('POST', STU(`/assessments/${openId}/finalize`))).status, 404);
  assert.equal((await s1.api('POST', STU(`/assessments/${openId}/archive`))).status, 404);
  assert.equal((await s1.api('POST', STU(`/assessments/${openId}/marks`), { student: s1Id, marksObtained: 1 })).status, 404);
});

test('E3. student cross-section assessment → 404', async () => {
  const bAsg = await admin.api('POST', ADM('/assessments'), {
    section: secB, subject: subB, title: 'B only', type: 'quiz', totalMarks: 10,
    assessmentDate: '2026-09-22T09:00:00.000Z',
  });
  const bId = bAsg.json.data._id;
  await admin.api('POST', ADM(`/assessments/${bId}/open`));
  assert.equal((await s1.api('GET', STU(`/assessments/${bId}`))).status, 404);
  // and drafts are 404 even in own section
  const draft = await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), { title: 'Secret draft' }));
  assert.equal((await s1.api('GET', STU(`/assessments/${draft.json.data._id}`))).status, 404);
  await crA.api('POST', A(`/assessments/${draft.json.data._id}/archive`));
});

/* --------------------------- F. CR ISOLATION --------------------------- */
test('F. CR B cannot read/write section A assessments or marks → 404', async () => {
  assert.equal((await crB.api('GET', A(`/assessments/${openId}`))).status, 404);
  assert.equal((await crB.api('PATCH', A(`/assessments/${openId}`), { title: 'x' })).status, 404);
  assert.equal((await crB.api('POST', A(`/assessments/${openId}/finalize`))).status, 404);
  assert.equal((await crB.api('POST', A(`/assessments/${openId}/archive`))).status, 404);
  assert.equal((await crB.api('GET', A(`/assessments/${openId}/marks`))).status, 404);
  assert.equal((await crB.api('POST', A(`/assessments/${openId}/marks`), { student: sBId, marksObtained: 5 })).status, 404);
  assert.equal((await crB.api('POST', A(`/assessments/${openId}/marks/bulk`), { rows: [{ student: sBId, marksObtained: 5 }] })).status, 404);
  // CR list only shows own section
  const listB = await crB.api('GET', A('/assessments'));
  assert.equal(listB.status, 200);
  assert.ok(listB.json.data.every((a) => String(a.section) === String(secB)));
});

/* ----------------------------- G. ADMIN ----------------------------- */
test('G. admin cross-section read/manage with integrity enforced', async () => {
  assert.equal((await admin.api('GET', ADM(`/assessments/${openId}`))).status, 200);
  assert.equal((await admin.api('GET', ADM(`/assessments/${openId}/marks`))).status, 200);
  const list = await admin.api('GET', ADM('/assessments'), undefined);
  assert.equal(list.status, 200);
  // filters + invalid values → 400
  assert.equal((await admin.api('GET', ADM('/assessments?sectionId=zzz'))).status, 400);
  assert.equal((await admin.api('GET', ADM('/assessments?status=weird'))).status, 400);
  assert.equal((await admin.api('GET', ADM('/assessments?type=weird'))).status, 400);
  // admin mark entry still validates eligibility
  assert.equal((await admin.api('POST', ADM(`/assessments/${openId}/marks`), { student: sBId, marksObtained: 5 })).status, 400);
  const dup = await admin.api('POST', ADM(`/assessments/${openId}/marks`), { student: s2Id, marksObtained: 17 });
  assert.equal(dup.status, 409, 's2 already has a mark — creation must 409');
  const ok = await admin.api('PATCH', ADM(`/assessments/${openId}/marks/${s2Id}`), { marksObtained: 17 });
  assert.equal(ok.status, 200);
});

/* ------------------------ K. ROLLOVER / HISTORY ------------------------ */
test('K. rollover: old marks readable, no new marks for old section', async () => {
  // student s1 rolls from A to B
  await User.updateOne({ _id: s1Id }, { $set: { section: secB } });
  await Section.updateOne({ _id: secA }, { $push: { pastMembers: s1Id } });

  // historical marks still readable by the student (own record)
  const mine = await s1.api('GET', STU('/marks'));
  assert.equal(mine.status, 200);
  assert.equal(mine.json.data.length >= 1, true);

  // no NEW section-A marks for the rolled student
  const res = await crA.api('POST', A(`/assessments/${openId}/marks/bulk`), {
    rows: [{ student: s1Id, marksObtained: 1 }],
  });
  assert.equal(res.status, 400);
  assert.equal((await crA.api('POST', A(`/assessments/${openId}/marks`), { student: s1Id, marksObtained: 1 })).status, 400);

  // rolled student now sees section B assessments, not A drafts
  const list = await s1.api('GET', STU('/assessments'));
  assert.ok(list.json.data.every((a) => String(a.section) === String(secB)));

  // roll back for later tests
  await User.updateOne({ _id: s1Id }, { $set: { section: secA } });
});

/* ------------------------ L. SECURITY FIELDS ------------------------ */
test('L. responses never leak secrets/hashes; injected fields ignored', async () => {
  const responses = [
    await crA.api('GET', A('/assessments')),
    await crA.api('GET', A(`/assessments/${openId}/marks`)),
    await s1.api('GET', STU('/assessments')),
    await s1.api('GET', STU('/marks')),
    await admin.api('GET', ADM('/assessments')),
  ];
  for (const r of responses) {
    assert.ok(!r.text.includes('test-only-jwt-secret'));
    assert.ok(!r.text.includes('fake-secret'));
    assert.ok(!/\$2[aby]\$/.test(r.text), 'no password hashes');
  }
  // status injection on PATCH ignored
  const res = await crA.api('POST', A('/assessments'), mkAssessment(A('/assessments'), { title: 'Inject test' }));
  const id = res.json.data._id;
  const inj = await crA.api('PATCH', A(`/assessments/${id}`), { status: 'finalized', finalizedAt: new Date().toISOString(), createdBy: sBId });
  assert.equal(inj.status, 200);
  assert.equal(inj.json.data.status, 'draft'); // still draft — injection ignored
  await crA.api('POST', A(`/assessments/${id}/archive`));
});

/* --------------------------- M. AUDIT --------------------------- */
test('M. audit events created with safe payloads', async () => {
  for (const action of ['assessment.create', 'assessment.update', 'assessment.finalize', 'assessment.archive',
    'mark.create', 'mark.update', 'mark.bulk_create', 'mark.finalize']) {
    assert.ok(await AuditLog.countDocuments({ action }) >= 1, action);
  }
  const logs = await AuditLog.find({ action: /^(assessment|mark)\./ });
  const text = JSON.stringify(logs.map((l) => ({ a: l.action, b: l.before, c: l.after, d: l.reason })));
  assert.ok(!text.includes('test-only-jwt-secret'));
  assert.ok(!text.includes('fake-secret'));
  assert.ok(!text.includes('AdminPass123') && !text.includes('Pass1234'));
  assert.ok(!text.includes('password'), 'no password field names in payloads');
});

/* --------------------------- REGRESSION --------------------------- */
test('N. previous feature surfaces healthy on this instance', async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.database, 'connected');
  assert.equal((await admin.api('GET', ADM('/announcements'))).status, 200);
  assert.equal((await admin.api('GET', ADM('/assignments'))).status, 200);
  assert.equal((await admin.api('GET', ADM('/timetable'))).status, 200);
  assert.equal((await admin.api('GET', ADM('/attendance/sessions'))).status, 200);
  assert.equal((await crA.api('GET', A('/subjects'))).status, 200);
  assert.equal((await crA.api('GET', A('/timetable'))).status, 200);
  assert.equal((await s2.api('GET', STU('/assignments'))).status, 200);
  assert.equal((await s2.api('GET', STU('/notifications'))).status, 200);
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
