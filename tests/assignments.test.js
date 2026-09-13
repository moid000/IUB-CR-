/**
 * STEP 6 tests — assignments + submissions. Isolated in-memory REPLICA SET;
 * deadline tests use the deterministic MOCK_NOW clock — never real-time waits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('assignments_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Section, Subject, Assignment, Submission, AuditLog } = models;
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
const cr1 = makeSession();   // section A
const cr2 = makeSession();    // section B
const student1 = makeSession(); // section A
const student2 = makeSession(); // section A

/* ================================ FIXTURES ================================ */
let deptCS, session1, secA, secB, subA1, subB1, subArchivedA;
let cr1Id, cr2Id, student1Id, student2Id;

const T0 = new Date('2026-10-01T10:00:00.000Z').getTime(); // fixed "now" for tests
const BEFORE = new Date(T0 - 3600_000).toISOString();       // due 1h ago
const AT = new Date(T0).toISOString();                     // exactly now
const AFTER = new Date(T0 + 3600_000).toISOString();       // due in 1h

function setNow(epoch = T0) { process.env.MOCK_NOW = String(epoch); }

test('fixtures: hierarchy + users', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  deptCS = (await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  session1 = (await admin.api('POST', '/api/admin/sessions', { name: '2027–28' })).json.data._id;
  secA = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5A' })).json.data._id;
  secB = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5B' })).json.data._id;

  const hash = await bcrypt.hash('CrPass123!', 10);
  cr1Id = (await User.create({ name: 'CR One', email: 'cr1@test.local', phone: '+923001110001', role: 'cr', registrationStatus: 'active', emailVerified: true, password: hash, section: secA }))._id;
  cr2Id = (await User.create({ name: 'CR Two', email: 'cr2@test.local', phone: '+923001110002', role: 'cr', registrationStatus: 'active', emailVerified: true, password: hash, section: secB }))._id;
  student1Id = (await User.create({ name: 'Student One', email: 's1@test.local', phone: '+923001110003', role: 'student', registrationStatus: 'active', emailVerified: true, password: hash, section: secA, rollNo: 'R-001' }))._id;
  student2Id = (await User.create({ name: 'Student Two', email: 's2@test.local', phone: '+923001110004', role: 'student', registrationStatus: 'active', emailVerified: true, password: hash, section: secA, rollNo: 'R-002' }))._id;
  await Section.updateOne({ _id: secA }, { $set: { cr: cr1Id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });

  subA1 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' })).json.data._id;
  subB1 = (await admin.api('POST', '/api/admin/subjects', { section: secB, name: 'Databases', code: 'DB-201' })).json.data._id;
  subArchivedA = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Old Course', code: 'OLD-1' })).json.data._id;
  assert.equal((await admin.api('POST', `/api/admin/subjects/${subArchivedA}/archive`)).status, 200);

  assert.equal((await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await cr2.api('POST', '/api/auth/login', { email: 'cr2@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await student1.api('POST', '/api/auth/login', { email: 's1@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await student2.api('POST', '/api/auth/login', { email: 's2@test.local', password: 'CrPass123!' })).status, 200);
});

/* ============================ ASSIGNMENT TESTS ============================ */
let aAdmin, aA1, aA2, aB1, aArchived;

test('1. admin creates assignment', async () => {
  const res = await admin.api('POST', '/api/admin/assignments', {
    section: secA, subject: subA1, title: 'ER diagram task', instructions: 'Draw the ER diagram.', deadline: AFTER,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.status, 'published');
  aAdmin = res.json.data._id;
  const got = await admin.api('GET', `/api/admin/assignments/${aAdmin}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.data.createdBy.name, 'Administrator'); // safe author info
  assert.equal(got.json.data.subject.name, 'Databases');
  assert.ok(!got.text.includes('password'));
});

test('2. CR creates assignment in own section (injections ignored)', async () => {
  const res = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Normalization task', instructions: 'Normalize to 3NF.', deadline: AFTER,
    section: secB, sectionId: secB, createdBy: student1Id, author: student1Id, role: 'student', status: 'archived',
  });
  assert.equal(res.status, 200);
  const doc = await Assignment.findById(res.json.data._id);
  assert.equal(String(doc.section), String(secA)); // server-derived
  assert.equal(String(doc.createdBy), String(cr1Id)); // (40) createdBy injection blocked
  assert.equal(doc.status, 'published'); // (42) status injection blocked
  aA1 = res.json.data._id;
});

test('3. CR cannot create assignment for another section', async () => {
  const res = await cr2.api('POST', '/api/cr/assignments', {
    subject: subB1, title: 'SecB task', instructions: 'Injected section.', section: secA, deadline: AFTER,
  });
  assert.equal(res.status, 200);
  const doc = await Assignment.findById(res.json.data._id);
  assert.equal(String(doc.section), String(secB)); // body.section ignored
  aB1 = res.json.data._id;
  const list = await cr1.api('GET', '/api/cr/assignments');
  assert.ok(!list.json.data.some((a) => String(a._id) === String(aB1)));
});

test('4. CR cannot use another section\'s subject', async () => {
  const res = await cr1.api('POST', '/api/cr/assignments', {
    subject: subB1, title: 'Cross-subject task', deadline: AFTER,
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /does not belong/i);
  assert.equal(await Assignment.countDocuments({ title: 'Cross-subject task' }), 0);
});

test('5. archived subject rejected', async () => {
  const res = await cr1.api('POST', '/api/cr/assignments', {
    subject: subArchivedA, title: 'Old course task', deadline: AFTER,
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /archived/i);
});

test('6. archived section rejected (admin)', async () => {
  const res = await admin.api('POST', '/api/admin/assignments', {
    section: secA, subject: subA1, title: 'Nope', deadline: AFTER,
  });
  assert.equal(res.status, 200);
  // archive the section then try again — admin cannot create for archived section
  const secC = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 6, name: '6C' })).json.data._id;
  const subC = (await admin.api('POST', '/api/admin/subjects', { section: secC, name: 'Networking', code: 'NET-1' })).json.data._id;
  assert.equal((await admin.api('POST', `/api/admin/sections/${secC}/archive`)).status, 200);
  const bad = await admin.api('POST', '/api/admin/assignments', {
    section: secC, subject: subC, title: 'Archived section task', deadline: AFTER,
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /archived/i);
});

test('7. invalid / missing due date rejected', async () => {
  for (const deadline of ['not-a-date', '', null, undefined]) {
    const res = await cr1.api('POST', '/api/cr/assignments', {
      subject: subA1, title: 'Bad deadline', deadline,
    });
    assert.equal(res.status, 400, `deadline=${JSON.stringify(deadline)}`);
  }
  assert.equal(await Assignment.countDocuments({ title: 'Bad deadline' }), 0);
  // ISO 8601 accepted and stored as UTC
  const ok = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'UTC check', deadline: '2026-12-31T23:59:59.000Z',
  });
  assert.equal(ok.status, 200);
  assert.equal(new Date(ok.json.data.deadline).toISOString(), '2026-12-31T23:59:59.000Z');
});

test('8. invalid ObjectIds handled safely (400, never 500)', async () => {
  assert.equal((await admin.api('GET', '/api/admin/assignments/zzz')).status, 400);
  assert.equal((await cr1.api('GET', '/api/cr/assignments/zzz')).status, 400);
  assert.equal((await student1.api('GET', '/api/student/assignments/zzz')).status, 400);
  assert.equal((await student1.api('POST', '/api/student/assignments/zzz/submission', { textAnswer: 'x' })).status, 400);
  assert.equal((await admin.api('GET', '/api/admin/assignments/zzz/submissions')).status, 400);
  assert.equal((await admin.api('GET', '/api/admin/submissions/zzz')).status, 400);
  assert.equal((await cr1.api('GET', '/api/cr/submissions/zzz')).status, 400);
});

test('9–11. lists are role-scoped', async () => {
  // admin lists everything, filters work
  const adminAll = await admin.api('GET', '/api/admin/assignments');
  assert.equal(adminAll.status, 200);
  assert.ok(adminAll.json.data.length >= 3);
  const bySection = await admin.api('GET', `/api/admin/assignments?sectionId=${secB}`);
  assert.ok(bySection.json.data.every((a) => String(a.section) === String(secB)));
  const bySubject = await admin.api('GET', `/api/admin/assignments?subjectId=${subA1}&status=published`);
  assert.ok(bySubject.json.data.every((a) => String(a.subject._id) === String(subA1)));

  // CR sees only own section
  const crList = await cr1.api('GET', '/api/cr/assignments');
  assert.ok(crList.json.data.every((a) => String(a.section) === String(secA)));
  assert.ok(crList.json.data.some((a) => String(a._id) === String(aA1)));
  assert.ok(!crList.json.data.some((a) => String(a._id) === String(aB1)));

  // student sees only own section — sectionId param ignored
  const stList = await student1.api('GET', `/api/student/assignments?sectionId=${secB}`);
  assert.ok(stList.json.data.every((a) => String(a.section) === String(secA)));
  assert.ok(!stList.json.data.some((a) => String(a._id) === String(aB1)));
});

test('12. cross-section assignment GET → 404 (never 403)', async () => {
  assert.equal((await cr1.api('GET', `/api/cr/assignments/${aB1}`)).status, 404);
  assert.equal((await cr1.api('PATCH', `/api/cr/assignments/${aB1}`, { title: 'Hacked' })).status, 404);
  assert.equal((await cr1.api('POST', `/api/cr/assignments/${aB1}/archive`)).status, 404);
  assert.equal((await student1.api('GET', `/api/student/assignments/${aB1}`)).status, 404);
  const aB1Doc = await Assignment.findById(aB1);
  assert.equal(aB1Doc.title, 'SecB task'); // untouched
});

test('13. assignment update works; subject re-link validated; section never moves', async () => {
  const res = await cr1.api('PATCH', `/api/cr/assignments/${aA1}`, {
    title: 'Normalization task v2', deadline: AFTER, section: secB, // section ignored
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.title, 'Normalization task v2');
  assert.equal(String((await Assignment.findById(aA1)).section), String(secA)); // never moved
  // (4-update-path) cross-section subject on update → 400
  const bad = await cr1.api('PATCH', `/api/cr/assignments/${aA1}`, { subject: subB1 });
  assert.equal(bad.status, 400);
  const archivedSub = await cr1.api('PATCH', `/api/cr/assignments/${aA1}`, { subject: subArchivedA });
  assert.equal(archivedSub.status, 400);
  // admin can update across sections
  assert.equal((await admin.api('PATCH', `/api/admin/assignments/${aB1}`, { title: 'SecB task v2' })).status, 200);
});

test('15–16. archive works, preserves everything, duplicate rejected', async () => {
  const res = await cr1.api('POST', `/api/cr/assignments/${aAdmin}/archive`);
  assert.equal(res.status, 200);
  const doc = await Assignment.findById(aAdmin);
  assert.equal(doc.status, 'archived');
  assert.equal(doc.title, 'ER diagram task'); // preserved
  assert.equal(String(doc.subject), String(subA1)); // preserved
  assert.equal(String(doc.createdBy), String((await User.findOne({ role: 'admin' }))._id)); // author preserved
  assert.equal((await cr1.api('POST', `/api/cr/assignments/${aAdmin}/archive`)).status, 409); // duplicate
  aArchived = aAdmin;
  // 14. archived cannot be updated
  assert.equal((await cr1.api('PATCH', `/api/cr/assignments/${aArchived}`, { title: 'Nope' })).status, 400);
  assert.equal((await admin.api('PATCH', `/api/admin/assignments/${aArchived}`, { title: 'Nope' })).status, 400);
  // archived still visible for historical context
  const hist = await student1.api('GET', `/api/student/assignments/${aArchived}`);
  assert.equal(hist.status, 200);
  assert.equal(hist.json.data.status, 'archived');
});

test('14b. admin duplicate archive also 409', async () => {
  assert.equal((await admin.api('POST', `/api/admin/assignments/${aArchived}/archive`)).status, 409);
});

/* ============================ SUBMISSION TESTS ============================ */
let s1Sub; // student1's submission id on aA1

test('17. student submits text (before deadline)', async () => {
  setNow(T0 - 60_000); // safely before
  const res = await student1.api('POST', `/api/student/assignments/${aA1}/submission`, {
    textAnswer: 'My 3NF solution.',
    student: student2Id, studentId: student2Id, // (22) injection — must be ignored
    section: secB, sectionId: secB, // (23) injection — must be ignored
    role: 'admin', isLate: true, status: 'late', // (39/42) manipulation — ignored
  });
  assert.equal(res.status, 200);
  const doc = await Submission.findById(res.json.data._id);
  assert.equal(String(doc.student), String(student1Id)); // (21) server-derived
  assert.equal(String(doc.section), String(secA)); // (23) server-derived
  assert.equal(doc.isLate, false); // (42) never client-controlled
  assert.equal(doc.textAnswer, 'My 3NF solution.');
  s1Sub = doc._id;
});

test('18. student submits attachment metadata (sanitized, uploadedBy forced)', async () => {
  const res = await student2.api('POST', `/api/student/assignments/${aA1}/submission`, {
    files: [{
      publicId: 'notes/abc123', url: 'https://res.cloudinary.com/demo/raw/upload/abc123.pdf',
      resourceType: 'raw', format: 'pdf', originalName: 'solution.pdf', size: 1024,
      uploadedBy: cr1Id, // must be overwritten server-side
    }, {
      publicId: 'bad', url: 'http://insecure.example/x', // http → rejected
    }],
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /https/i);
  // retry with valid https only
  const ok = await student2.api('POST', `/api/student/assignments/${aA1}/submission`, {
    files: [{ publicId: 'notes/abc123', url: 'https://res.cloudinary.com/demo/raw/upload/abc123.pdf', resourceType: 'raw', format: 'pdf', originalName: 'solution.pdf', size: 1024, uploadedBy: cr1Id }],
  });
  assert.equal(ok.status, 200);
  assert.equal((await Submission.findById(ok.json.data._id)).files[0].uploadedBy.toString(), String(student2Id));
});

test('19. text + attachment together; 20. empty rejected', async () => {
  const res = await student1.api('POST', `/api/student/assignments/${aA1}/submission`, {
    textAnswer: 'Answer + file.',
    files: [{ publicId: 'x/y', url: 'https://res.cloudinary.com/demo/raw/upload/y.zip', size: 10 }],
  });
  assert.equal(res.status, 200);
  const empty1 = await student1.api('POST', `/api/student/assignments/${aA1}/submission`, { textAnswer: '   ' });
  assert.equal(empty1.status, 400); // whitespace-only text is not meaningful
  const empty2 = await student2.api('POST', `/api/student/assignments/${aA1}/submission`, {});
  assert.equal(empty2.status, 400); // student2 has a record — but empty payload → 400 before upsert
});

test('24–26. resubmission updates the SAME record; count stays 1', async () => {
  const beforeDoc = await Submission.findById(s1Sub);
  const beforeCount = await Submission.countDocuments({ assignment: aA1, student: student1Id });
  assert.equal(beforeCount, 1);
  await new Promise((r) => setTimeout(r, 10)); // let updatedAt advance deterministically
  const res = await student1.api('POST', `/api/student/assignments/${aA1}/submission`, {
    textAnswer: 'My 3NF solution — REVISED.',
  });
  assert.equal(res.status, 200);
  assert.equal(String(res.json.data._id), String(s1Sub)); // same record
  assert.equal(await Submission.countDocuments({ assignment: aA1, student: student1Id }), 1);
  const doc = await Submission.findById(s1Sub);
  assert.equal(doc.textAnswer, 'My 3NF solution — REVISED.');
  assert.equal(doc.files.length, 0); // latest payload replaced the old one
  assert.equal(doc.submittedAt.getTime(), beforeDoc.submittedAt.getTime()); // original submit preserved
  assert.ok(doc.updatedAt.getTime() > beforeDoc.updatedAt.getTime()); // resubmission bumps updatedAt
});

test('27. submission exactly at deadline allowed', async () => {
  // aA1 deadline = AFTER; set now exactly AT the deadline
  setNow(new Date(AFTER).getTime());
  const res = await student2.api('POST', `/api/student/assignments/${aA1}/submission`, {
    textAnswer: 'At the wire.',
  });
  assert.equal(res.status, 200); // now == deadline → allowed
});

test('28–29. after deadline: new + resubmission rejected, nothing modified', async () => {
  // fresh assignment whose deadline is AFTER — never submitted to by student1
  const aA3 = (await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Late test', deadline: AFTER,
  })).json.data._id;
  setNow(new Date(AFTER).getTime() + 1); // 1ms past deadline
  const fresh = await student1.api('POST', `/api/student/assignments/${aA3}/submission`, { textAnswer: 'Too late.' });
  assert.equal(fresh.status, 400);
  assert.match(fresh.json.message, /deadline/i);
  const again = await student1.api('POST', `/api/student/assignments/${aA1}/submission`, { textAnswer: 'Also late.' });
  assert.equal(again.status, 400);
  assert.equal(await Submission.countDocuments({ assignment: aA3, student: student1Id }), 0); // no record created
  const doc = await Submission.findById(s1Sub);
  assert.equal(doc.textAnswer, 'My 3NF solution — REVISED.'); // untouched
  setNow(T0); // restore
});

test('30. archived assignment rejects new submissions', async () => {
  const res = await student1.api('POST', `/api/student/assignments/${aArchived}/submission`, {
    textAnswer: 'Try archived.',
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /archived/i);
  assert.equal(await Submission.countDocuments({ assignment: aArchived }), 0);
});

test('31–32. student reads OWN submission only; cross-read impossible', async () => {
  const mine = await student1.api('GET', `/api/student/assignments/${aA1}/submission`);
  assert.equal(mine.status, 200);
  assert.equal(String(mine.json.data.student._id ?? mine.json.data.student), String(student1Id));
  assert.equal(mine.json.data.assignment.title, 'Normalization task v2');

  const mine2 = await student2.api('GET', `/api/student/assignments/${aA1}/submission`);
  assert.equal(mine2.status, 200);
  assert.equal(String(mine2.json.data.student._id ?? mine2.json.data.student), String(student2Id));
  assert.notEqual(String(mine.json.data._id), String(mine2.json.data._id)); // distinct records

  // no route ever accepts a student id — cross-student read is structurally
  // impossible; a submission the student never made simply 404s
  const aA3 = (await Assignment.findOne({ title: 'Late test' }))._id;
  assert.equal((await student1.api('GET', `/api/student/assignments/${aA3}/submission`)).status, 404);
});

test('33–36. CR submission views; read-only; cross-section 404', async () => {
  const res = await cr1.api('GET', `/api/cr/assignments/${aA1}/submissions`);
  assert.equal(res.status, 200);
  assert.ok(res.json.data.length >= 2);
  assert.ok(res.json.data.every((s) => String(s.assignment) === String(aA1)));
  const one = await cr1.api('GET', `/api/cr/submissions/${s1Sub}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.data.student.name, 'Student One');

  // cross-section: CR2's assignment submissions → 404 for CR1
  assert.equal((await cr1.api('GET', `/api/cr/assignments/${aB1}/submissions`)).status, 404);
  // CR1 cannot even list via CR2's submission ids — same 404
  const cr2List = await cr2.api('GET', `/api/cr/assignments/${aB1}/submissions`);
  assert.equal(cr2List.status, 200); // cr2 CAN (own section)

  // 36. CR has no submission mutation route at all — attempts 404/403
  assert.equal((await cr1.api('PATCH', `/api/cr/submissions/${s1Sub}`, { textAnswer: 'Hacked' })).status, 404);
  assert.equal((await cr1.api('POST', `/api/cr/assignments/${aA1}/submissions`)).status, 404);
  const doc = await Submission.findById(s1Sub);
  assert.equal(doc.textAnswer, 'My 3NF solution — REVISED.'); // untouched
});

test('35. admin views submissions across sections', async () => {
  const list = await admin.api('GET', `/api/admin/assignments/${aA1}/submissions`);
  assert.equal(list.status, 200);
  assert.ok(list.json.data.length >= 2);
  const one = await admin.api('GET', `/api/admin/submissions/${s1Sub}`);
  assert.equal(one.status, 200);
  const cr2Sub = await admin.api('GET', `/api/admin/assignments/${aB1}/submissions`);
  assert.equal(cr2Sub.status, 200); // cross-section fine for admin
});

test('37. historical submissions survive assignment archive', async () => {
  assert.equal((await cr1.api('POST', `/api/cr/assignments/${aA1}/archive`)).status, 200);
  // submissions remain readable
  assert.equal((await student1.api('GET', `/api/student/assignments/${aA1}/submission`)).status, 200);
  assert.equal((await cr1.api('GET', `/api/cr/assignments/${aA1}/submissions`)).status, 200);
  const doc = await Submission.findById(s1Sub);
  assert.equal(doc.section.toString(), String(secA)); // historical section intact
  // but no NEW submissions
  assert.equal((await student1.api('POST', `/api/student/assignments/${aA1}/submission`, { textAnswer: 'Post-archive' })).status, 400);
});

test('38. duplicate-key race handled safely (upsert stays one record)', async () => {
  // fresh assignment — direct raw insert simulates a concurrent first submit,
  // then the student's upsert must resolve to ONE record, not an error or a dup
  const aA4 = (await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Race test', deadline: AFTER,
  })).json.data._id;
  await Submission.create({
    assignment: aA4, student: student2Id, section: secA, textAnswer: 'race', submittedAt: new Date(T0),
  });
  const res = await student2.api('POST', `/api/student/assignments/${aA4}/submission`, { textAnswer: 'race-resolved' });
  assert.equal(res.status, 200); // upsert resolves to the existing record
  assert.equal(await Submission.countDocuments({ assignment: aA4, student: student2Id }), 1);
  assert.equal((await Submission.findOne({ assignment: aA4, student: student2Id })).textAnswer, 'race-resolved');
});

/* ============================ SECURITY TESTS ============================ */
test('39–42. role/createdBy/ownership/deadline manipulation blocked', async () => {
  // student can never reach CR/admin mutation routes
  assert.equal((await student1.api('POST', '/api/cr/assignments', { subject: subA1, title: 'X', deadline: AFTER })).status, 403);
  assert.equal((await student1.api('POST', '/api/admin/assignments', { section: secA, subject: subA1, title: 'X', deadline: AFTER })).status, 403);
  // client deadline/status/late flags are never read from body — verified in tests 17/24-29;
  // final DB state sanity:
  const subs = await Submission.find({ student: student1Id });
  assert.ok(subs.every((s) => s.isLate === false));
});

test('45. sensitive fields never returned', async () => {
  const checks = [
    await admin.api('GET', '/api/admin/assignments'),
    await cr1.api('GET', '/api/cr/assignments'),
    await student1.api('GET', '/api/student/assignments'),
    await admin.api('GET', `/api/admin/assignments/${aA1}/submissions`),
    await cr1.api('GET', '/api/cr/assignments'),
  ];
  for (const r of checks) {
    assert.ok(!/\$2[aby]\$/.test(r.text), 'no hash');
    assert.ok(!r.text.includes('activationToken') && !r.text.includes('resetToken') && !r.text.includes('codeHash'));
    assert.ok(!r.text.includes('api_key') && !r.text.includes('api_secret')); // no signing secrets
  }
});

test('46–47. audit events created safely; submission content NOT in audit log', async () => {
  for (const action of ['assignment.create', 'assignment.update', 'assignment.archive',
    'submission.create', 'submission.update']) {
    assert.ok(await AuditLog.countDocuments({ action }) > 0, `${action} recorded`);
  }
  const subLogs = await AuditLog.find({ action: /^submission\./ });
  const text = JSON.stringify(subLogs.map((l) => ({ b: l.before, a: l.after })));
  assert.ok(!text.includes('My 3NF solution'), 'submission text never copied into audit');
  assert.ok(!text.includes('password') && !text.includes('CrPass'));
  assert.ok(text.includes('files'), 'audit carries metadata counts only');
});

test('48–52. regression guard: earlier-phase routes healthy', async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.database, 'connected');
  assert.equal((await admin.api('GET', '/api/admin/subjects')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/announcements')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/notes')).status, 200);
  assert.equal((await cr1.api('GET', '/api/cr/subjects')).status, 200);
  assert.equal((await student1.api('GET', '/api/student/announcements')).status, 200);
  assert.equal((await student1.api('GET', '/api/student/notes')).status, 200);
  const bad = await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'Wrong1!' });
  assert.equal(bad.status, 401);
  // search safely escaped on assignments
  const weird = await cr1.api('GET', '/api/cr/assignments?search=.*');
  assert.equal(weird.status, 200);
  // pagination cap
  const capped = await admin.api('GET', '/api/admin/assignments?limit=9999');
  assert.equal(capped.json.pagination.limit, 100);
});

test.after(async () => {
  delete process.env.MOCK_NOW;
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
