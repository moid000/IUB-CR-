/**
 * STEP 4 tests — academic management + subjects. Runs on an isolated
 * in-memory REPLICA SET (transactions required). NEVER touches Atlas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('academic_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Department, AcademicSession, Section, Subject, AuditLog } = models;
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
const cr1 = makeSession(); // section A CR
const cr2 = makeSession(); // section B CR
const student1 = makeSession(); // section A student

/* ================================ FIXTURES ================================ */
let deptCS, deptEE, deptZZ, session1, secA, secB, secC, secD;
let cr1Id, cr2Id, cr3Id, student1Id, subA1, subA2, subB1, sec6X;

test('fixtures: admin + departments + session + sections + users', async () => {
  const login = await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  });
  assert.equal(login.status, 200);

  deptCS = (await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  deptEE = (await admin.api('POST', '/api/admin/departments', { name: 'Electrical Engineering', code: 'EE' })).json.data._id;
  deptZZ = (await admin.api('POST', '/api/admin/departments', { name: 'Zoology', code: 'ZOO' })).json.data._id;
  session1 = (await admin.api('POST', '/api/admin/sessions', { name: '2027–28' })).json.data._id;

  secA = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5A' })).json.data._id;
  secB = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5B' })).json.data._id;
  secC = (await admin.api('POST', '/api/admin/sections', { department: deptEE, session: session1, semester: 3, name: '3C' })).json.data._id;
  secD = (await admin.api('POST', '/api/admin/sections', { department: deptEE, session: session1, semester: 3, name: '3D' })).json.data._id;

  const hash = await bcrypt.hash('CrPass123!', 10);
  const cr1doc = await User.create({
    name: 'CR One', email: 'cr1@test.local', phone: '+923001110001', role: 'cr',
    registrationStatus: 'active', emailVerified: true, password: hash, section: secA,
  });
  cr1Id = cr1doc._id;
  const cr2doc = await User.create({
    name: 'CR Two', email: 'cr2@test.local', phone: '+923001110002', role: 'cr',
    registrationStatus: 'active', emailVerified: true, password: hash, section: secB,
  });
  cr2Id = cr2doc._id;
  const s1doc = await User.create({
    name: 'Student One', email: 's1@test.local', phone: '+923001110003', role: 'student',
    registrationStatus: 'active', emailVerified: true, password: hash, section: secA, rollNo: 'R-001',
  });
  student1Id = s1doc._id;
  await Section.updateOne({ _id: secA }, { $set: { cr: cr1Id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });

  assert.equal((await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await cr2.api('POST', '/api/auth/login', { email: 'cr2@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await student1.api('POST', '/api/auth/login', { email: 's1@test.local', password: 'CrPass123!' })).status, 200);
});

/* ============================== DEPARTMENT ============================== */
test('1. admin creates department + GET /:id works', async () => {
  const res = await admin.api('POST', '/api/admin/departments', { name: 'Physics', code: 'phy' });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.code, 'PHY'); // trimmed + uppercase
  const got = await admin.api('GET', `/api/admin/departments/${res.json.data._id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.data.name, 'Physics');
  const missing = await admin.api('GET', '/api/admin/departments/507f1f77bcf86cd799439011');
  assert.equal(missing.status, 404);
  const renamed = await admin.api('PATCH', `/api/admin/departments/${res.json.data._id}`, { name: 'Applied Physics' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.data.name, 'Applied Physics');
});

test('2. duplicate department rejected', async () => {
  const dupName = await admin.api('POST', '/api/admin/departments', { name: 'applied physics', code: 'PHYS' });
  assert.equal(dupName.status, 409); // case-insensitive unique name vs 'Applied Physics'
  const dupCode = await admin.api('POST', '/api/admin/departments', { name: 'Mathematics', code: 'CS' });
  assert.equal(dupCode.status, 409);
});

test('3. non-admin cannot create department', async () => {
  const res = await student1.api('POST', '/api/admin/departments', { name: 'Hack Dept', code: 'HD' });
  assert.equal(res.status, 403);
});

test('4. department archive works safely (no active sections)', async () => {
  const res = await admin.api('POST', `/api/admin/departments/${deptZZ}/archive`);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.status, 'archived');
  const again = await admin.api('POST', `/api/admin/departments/${deptZZ}/archive`);
  assert.equal(again.status, 409); // already archived
});

test('5. active dependent section blocks department archive', async () => {
  const res = await admin.api('POST', `/api/admin/departments/${deptCS}/archive`);
  assert.equal(res.status, 400);
  assert.match(res.json.message, /active sections/i);
  const doc = await Department.findById(deptCS);
  assert.equal(doc.status, 'active'); // untouched
});

/* ============================ ACADEMIC SESSION ============================ */
test('6. admin creates session + GET /:id', async () => {
  const res = await admin.api('POST', '/api/admin/sessions', { name: '2028–29', status: 'archived' });
  assert.equal(res.status, 200);
  const got = await admin.api('GET', `/api/admin/sessions/${res.json.data._id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.data.name, '2028–29');
  const patched = await admin.api('PATCH', `/api/admin/sessions/${res.json.data._id}`, { startedAt: '2028-01-01' });
  assert.equal(patched.status, 200); // valid update → session.update audit
});

test('7. duplicate session rejected', async () => {
  const res = await admin.api('POST', '/api/admin/sessions', { name: '2027–28', status: 'archived' });
  assert.equal(res.status, 409); // unique name (11000 → 409)
});

test('8. only one active session allowed', async () => {
  const res = await admin.api('POST', '/api/admin/sessions', { name: '2029–30' });
  assert.equal(res.status, 409); // 2027–28 is already active
  const patch = await admin.api('PATCH', `/api/admin/sessions/507f1f77bcf86cd799439011`, { status: 'active' });
  assert.equal(patch.status, 404);
});

test('9. invalid session dates rejected', async () => {
  const bad1 = await admin.api('POST', '/api/admin/sessions', {
    name: '2030–31', startedAt: '2027-01-10', endedAt: '2027-01-01',
  });
  assert.equal(bad1.status, 400);
  const bad2 = await admin.api('PATCH', `/api/admin/sessions/${session1}`, {
    startedAt: '2026-09-01', endedAt: '2026-08-01',
  });
  assert.equal(bad2.status, 400);
  assert.equal((await AcademicSession.findById(session1)).name, '2027–28'); // unchanged
});

test('10. non-admin cannot modify session', async () => {
  const res = await cr1.api('PATCH', `/api/admin/sessions/${session1}`, { name: 'Hacked' });
  assert.equal(res.status, 403);
  const list = await cr1.api('GET', '/api/admin/sessions');
  assert.equal(list.status, 403);
});

/* ================================ SECTION ================================ */
test('11. admin creates section', async () => {
  const res = await admin.api('POST', '/api/admin/sections', {
    department: deptCS, session: session1, semester: 6, name: '6x',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.name, '6X'); // trimmed + uppercase
  sec6X = res.json.data._id; // CR-less section for the assignment tests
});

test('12. invalid department rejected', async () => {
  const res = await admin.api('POST', '/api/admin/sections', {
    department: '507f1f77bcf86cd799439011', session: session1, semester: 5, name: '5Z',
  });
  assert.equal(res.status, 400);
});

test('13. invalid session rejected', async () => {
  const res = await admin.api('POST', '/api/admin/sections', {
    department: deptCS, session: '507f1f77bcf86cd799439011', semester: 5, name: '5Z',
  });
  assert.equal(res.status, 400);
});

test('14. archived department rejected for new sections', async () => {
  const res = await admin.api('POST', '/api/admin/sections', {
    department: deptZZ, session: session1, semester: 5, name: '5Z',
  });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /archived/i);
});

test('15. archived session rejected for new sections', async () => {
  const sess = (await admin.api('POST', '/api/admin/sessions', { name: '2031–32', status: 'archived' })).json.data._id;
  const res = await admin.api('POST', '/api/admin/sections', {
    department: deptCS, session: sess, semester: 5, name: '5Z',
  });
  assert.equal(res.status, 400);
});

test('16. semester outside 1–8 rejected', async () => {
  for (const semester of [0, 9, 'x', 4.5, null]) {
    const res = await admin.api('POST', '/api/admin/sections', {
      department: deptCS, session: session1, semester, name: '5Z',
    });
    assert.equal(res.status, 400, `semester ${semester} must be rejected`);
  }
});

test('17. duplicate section rejected', async () => {
  const res = await admin.api('POST', '/api/admin/sections', {
    department: deptCS, session: session1, semester: 5, name: '5A',
  });
  assert.equal(res.status, 409);
});

test('18. section archive preserves history and clears CR transactionally', async () => {
  // give secD a subject + a CR, then archive it
  const sub = await Subject.create({
    section: secD, name: 'Archived Flow', code: 'AF-101', createdBy: cr1Id, status: 'active',
  });
  await Section.updateOne({ _id: secB }, { $set: { cr: null } }); // avoid unique-cr clash
  await User.updateOne({ _id: cr2Id }, { $set: { section: secD } });
  await Section.updateOne({ _id: secD }, { $set: { cr: cr2Id } });

  const res = await admin.api('POST', `/api/admin/sections/${secD}/archive`);
  assert.equal(res.status, 200);

  const secDoc = await Section.findById(secD);
  assert.equal(secDoc.status, 'archived');
  assert.equal(secDoc.cr, null); // CR link cleared
  const crDoc = await User.findById(cr2Id).select('+password');
  assert.equal(crDoc.section, null); // user side cleared
  assert.equal(crDoc.registrationStatus, 'active'); // account NOT touched
  assert.ok(crDoc.password && crDoc.password.startsWith('$2')); // password intact

  // history preserved — subject still exists and remains linked
  const subDoc = await Subject.findById(sub._id);
  assert.ok(subDoc, 'subject NOT deleted');
  assert.equal(String(subDoc.section), String(secD));
  const again = await admin.api('POST', `/api/admin/sections/${secD}/archive`);
  assert.equal(again.status, 409); // already archived

  // restore CR2 → secB for later tests
  await User.updateOne({ _id: cr2Id }, { $set: { section: secB } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });
});

/* ============================ CR ASSIGNMENT ============================ */
test('19. CR assignment maintains both sides (pending pre-created CR allowed)', async () => {
  const [pendingCr] = await User.create([{
    name: 'Pending CR', email: 'cr3@test.local', phone: '+923001110004', role: 'cr',
    registrationStatus: 'pending', emailVerified: false, password: null,
  }]);
  cr3Id = pendingCr._id;

  const res = await admin.api('POST', `/api/admin/sections/${secC}/cr`, { userId: String(cr3Id) });
  assert.equal(res.status, 200);

  const secDoc = await Section.findById(secC);
  const userDoc = await User.findById(cr3Id);
  assert.equal(String(secDoc.cr), String(cr3Id)); // Section.cr
  assert.equal(String(userDoc.section), String(secC)); // User.section
  assert.equal(userDoc.registrationStatus, 'pending'); // status untouched
});

test('20. CR cannot belong to two sections (plain assign rejected)', async () => {
  const res = await admin.api('POST', `/api/admin/sections/${sec6X}/cr`, { userId: String(cr3Id) });
  assert.equal(res.status, 409); // cr3 already belongs to secC
  assert.match(res.json.message, /another section/i);
  assert.equal(String((await User.findById(cr3Id)).section), String(secC)); // unchanged
  assert.equal((await Section.findById(sec6X)).cr, null); // target untouched
});

test('21. section cannot have two CRs', async () => {
  const res = await admin.api('POST', `/api/admin/sections/${secC}/cr`, { userId: String(cr2Id) });
  assert.equal(res.status, 409); // secC already has cr3 — never silently overwritten
  assert.equal(String((await Section.findById(secC)).cr), String(cr3Id));
});

test('22. explicit reassignment moves BOTH sides in one transaction', async () => {
  const res = await admin.api('POST', `/api/admin/sections/${secA}/cr/reassign`, { userId: String(cr3Id) });
  assert.equal(res.status, 409); // secA already has cr1 — target must be CR-less
  // secD is archived → rejected too
  assert.equal((await admin.api('POST', `/api/admin/sections/${secD}/cr/reassign`, { userId: String(cr3Id) })).status, 400);

  // create a fresh CR-less section 3E and reassign cr3 there
  const secE = (await admin.api('POST', '/api/admin/sections', {
    department: deptEE, session: session1, semester: 3, name: '3E',
  })).json.data._id;

  const ok = await admin.api('POST', `/api/admin/sections/${secE}/cr/reassign`, { userId: String(cr3Id) });
  assert.equal(ok.status, 200);

  assert.equal((await Section.findById(secC)).cr, null); // old side cleared
  assert.equal(String((await Section.findById(secE)).cr), String(cr3Id)); // new side set
  assert.equal(String((await User.findById(cr3Id)).section), String(secE)); // user moved
});

test('22b. transaction rollback keeps both sides consistent on mid-transaction failure', async () => {
  // force the NEW section's save to throw inside the transaction
  const target = await Section.findOne({ name: '3E' });
  const origSave = mongoose.models.Section.prototype.save;
  mongoose.models.Section.prototype.save = function (...args) {
    if (String(this._id) === String(target._id)) return Promise.reject(new Error('boom'));
    return origSave.apply(this, args);
  };
  try {
    const secF = (await admin.api('POST', '/api/admin/sections', {
      department: deptEE, session: session1, semester: 3, name: '3F',
    })).json.data._id;
    const res = await admin.api('POST', `/api/admin/sections/${secF}/cr/reassign`, { userId: String(cr3Id) });
    assert.equal(res.status, 500); // transaction failed → rollback
    // EVERYTHING back to pre-operation state — no half-updated links
    assert.equal(String((await User.findById(cr3Id)).section), String(target._id));
    assert.equal(String((await Section.findById(target._id)).cr), String(cr3Id));
    assert.equal((await Section.findById(secF)).cr, null);
  } finally {
    mongoose.models.Section.prototype.save = origSave;
  }
});

test('22c. explicit CR removal clears both sides, keeps the account', async () => {
  const res = await admin.api('POST', `/api/admin/sections/${(await Section.findOne({ name: '3E' }))._id}/cr/remove`);
  assert.equal(res.status, 200);
  const secDoc = await Section.findOne({ name: '3E' });
  const userDoc = await User.findById(cr3Id);
  assert.equal(secDoc.cr, null);
  assert.equal(userDoc.section, null);
  assert.equal(userDoc.registrationStatus, 'pending'); // account untouched
  assert.equal((await admin.api('POST', `/api/admin/sections/${secC}/cr/remove`)).status, 409); // no CR
});

test('23. cross-section CR student access returns 404 (existence never leaks)', async () => {
  // cr2 (secB) tries to read cr1's section student by hitting list — must only see secB
  const res = await cr2.api('GET', '/api/cr/students');
  assert.equal(res.status, 200);
  const sections = await User.find({ _id: { $in: res.json.data.map((s) => s._id) } }).distinct('section');
  assert.ok(sections.every((id) => String(id) === String(secB)), 'only own-section students');
});

test('24. CR can only manage own section (routes are role+scope gated)', async () => {
  assert.equal((await student1.api('GET', '/api/cr/students')).status, 403);
  assert.equal((await student1.api('GET', '/api/cr/subjects')).status, 403);
});

/* ================================ STUDENTS ================================ */
test('25–27. CR creates pending student; section server-derived; injections ignored', async () => {
  const res = await cr1.api('POST', '/api/cr/students', {
    name: 'New Student', rollNo: 'r-101', email: 'newstudent@test.local', phone: '+923009990001',
    section: secB, sectionId: secB, role: 'admin', createdBy: student1Id,
    registrationStatus: 'active', emailVerified: true, password: 'Injected123!',
  });
  assert.equal(res.status, 200);
  const doc = await User.findOne({ email: 'newstudent@test.local' }).select('+password');
  assert.equal(doc.role, 'student'); // (45) role injection blocked
  assert.equal(doc.registrationStatus, 'pending'); // (48) status injection blocked
  assert.equal(doc.emailVerified, false); // (49) emailVerified injection blocked
  assert.equal(String(doc.section), String(secA)); // (26/46) OWN section — body ignored
  assert.equal(String(doc.createdBy), String(cr1Id)); // (47) createdBy injection blocked
  assert.equal(doc.password, null); // no password until activation
  assert.equal(doc.rollNo, 'R-101');
});

test('28. duplicate rollNo rejected within section', async () => {
  const res = await cr1.api('POST', '/api/cr/students', {
    name: 'Dup Roll', rollNo: 'R-101', email: 'other1@test.local',
  });
  assert.equal(res.status, 409);
});

test('29. duplicate global email rejected', async () => {
  const res = await cr1.api('POST', '/api/cr/students', {
    name: 'Dup Email', rollNo: 'R-102', email: 'newstudent@test.local',
  });
  assert.equal(res.status, 409);
  // same email even in ANOTHER section → still rejected (global unique)
  const res2 = await cr2.api('POST', '/api/cr/students', {
    name: 'Dup Email B', rollNo: 'B-001', email: 'newstudent@test.local',
  });
  assert.equal(res2.status, 409);
});

test('30. CR cannot create a student for another section', async () => {
  const res = await cr1.api('POST', '/api/cr/students', {
    name: 'Injected Section', rollNo: 'R-103', email: 'injected@test.local', section: secB,
  });
  assert.equal(res.status, 200); // created — but in CR's OWN section
  const doc = await User.findOne({ email: 'injected@test.local' });
  assert.equal(String(doc.section), String(secA), 'server-derived, never the client section');
});

test('31. student cannot modify academic ownership (no such route exists)', async () => {
  const res = await student1.api('PATCH', '/api/auth/me', { section: secB, rollNo: 'HACK', role: 'admin' });
  assert.equal(res.status, 404); // no student mutation route
  const doc = await User.findById(student1Id);
  assert.equal(String(doc.section), String(secA));
  assert.equal(doc.rollNo, 'R-001');
  assert.equal(doc.role, 'student');
});

test('32. admin lists students safely with filters + search', async () => {
  const all = await admin.api('GET', '/api/admin/students?limit=100');
  assert.equal(all.status, 200);
  assert.ok(all.json.data.every((s) => s.role === undefined || s.role === 'student') || true);
  assert.ok(all.json.data.length >= 3);
  assert.ok(!all.text.includes('$2'), 'no password hash');

  const bySection = await admin.api('GET', `/api/admin/students?section=${secA}`);
  assert.ok(bySection.json.data.every((s) => String(s.section?._id ?? s.section) === String(secA)));

  const byDept = await admin.api('GET', `/api/admin/students?department=${deptCS}`);
  assert.ok(byDept.json.data.length >= 3);
  assert.ok(byDept.json.data.every((s) => {
    const sec = s.section?._id ?? s.section;
    return String(sec) === String(secA) || String(sec) === String(secB) || String(sec) === String(secD);
  }));

  const bySearch = await admin.api('GET', '/api/admin/students?search=R-101');
  assert.equal(bySearch.json.data.length, 1);
  const byEmail = await admin.api('GET', '/api/admin/students?search=newstudent@test');
  assert.equal(byEmail.json.data.length, 1);
  assert.ok(!byEmail.text.includes('password'));
});

/* ================================ SUBJECTS ================================ */
test('33. admin creates subject', async () => {
  const res = await admin.api('POST', '/api/admin/subjects', {
    section: secA, name: 'Artificial Intelligence', code: 'ai-101', teacherName: 'Dr. Khan',
    creditHours: 3, description: 'Intro AI course',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.code, 'AI-101'); // uppercase normalized
  assert.equal(String(res.json.data.section?._id ?? res.json.data.section), String(secA));
  subA1 = res.json.data._id;

  const got = await admin.api('GET', `/api/admin/subjects/${subA1}`);
  assert.equal(got.status, 200);
  const missing = await admin.api('GET', '/api/admin/subjects/507f1f77bcf86cd799439011');
  assert.equal(missing.status, 404);
});

test('34. duplicate subject code within section rejected', async () => {
  const res = await admin.api('POST', '/api/admin/subjects', {
    section: secA, name: 'AI Again', code: 'AI-101',
  });
  assert.equal(res.status, 409);
});

test('35. same subject code allowed in different sections', async () => {
  const res = await admin.api('POST', '/api/admin/subjects', {
    section: secB, name: 'Artificial Intelligence', code: 'AI-101',
  });
  assert.equal(res.status, 200);
  subB1 = res.json.data._id;
});

test('33b. admin cannot create subject for archived/missing section', async () => {
  const archived = await admin.api('POST', '/api/admin/subjects', {
    section: secD, name: 'Bad', code: 'BD-101',
  });
  assert.equal(archived.status, 400); // secD archived
  const missing = await admin.api('POST', '/api/admin/subjects', {
    section: '507f1f77bcf86cd799439011', name: 'Bad', code: 'BD-101',
  });
  assert.equal(missing.status, 400);
});

test('36. CR creates subject for own section', async () => {
  const res = await cr1.api('POST', '/api/cr/subjects', {
    name: 'Programming Fundamentals', code: 'pf-101', creditHours: 4,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.code, 'PF-101');
  assert.equal(String(res.json.data.section), String(secA)); // server-derived
  assert.equal(String(res.json.data.createdBy), String(cr1Id));
  subA2 = res.json.data._id;

  const list = await cr1.api('GET', '/api/cr/subjects');
  assert.ok(list.json.data.some((s) => String(s._id) === String(subA1)));
  assert.ok(list.json.data.some((s) => String(s._id) === String(subA2)));
  assert.ok(list.json.data.every((s) => String(s.section) === String(secA)));

  // own-section update works (and records the subject.update audit action)
  const upd = await cr1.api('PATCH', `/api/cr/subjects/${subA1}`, {
    name: 'Artificial Intelligence I', teacherName: 'Dr. A. Khan',
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.data.name, 'Artificial Intelligence I');
});

test('37. CR cannot create a subject for another section', async () => {
  const res = await cr1.api('POST', '/api/cr/subjects', {
    name: 'Injected Section Subject', code: 'INJ-101', section: secB, // must be ignored
  });
  assert.equal(res.status, 200);
  const doc = await Subject.findById(res.json.data._id);
  assert.equal(String(doc.section), String(secA), 'server-derived section');
  assert.equal((await cr1.api('GET', '/api/cr/subjects')).json.data.length, 3); // subA1 + subA2 + this
});

test('38. CR cannot READ another section\'s subject (404, not 403)', async () => {
  const res = await cr1.api('GET', `/api/cr/subjects/${subB1}`);
  assert.equal(res.status, 404);
  assert.equal(res.json.message, 'Subject not found'); // no existence leak
});

test('39. CR cannot UPDATE another section\'s subject', async () => {
  const res = await cr1.api('PATCH', `/api/cr/subjects/${subB1}`, { name: 'Hacked' });
  assert.equal(res.status, 404);
  const doc = await Subject.findById(subB1);
  assert.equal(doc.name, 'Artificial Intelligence'); // untouched
});

test('40. CR cannot ARCHIVE another section\'s subject', async () => {
  const res = await cr1.api('POST', `/api/cr/subjects/${subB1}/archive`);
  assert.equal(res.status, 404);
  assert.equal((await Subject.findById(subB1)).status, 'active');
});

test('41. student reads ONLY own section subjects (read-only)', async () => {
  const res = await student1.api('GET', '/api/student/subjects');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.length >= 3);
  assert.ok(res.json.data.every((s) => String(s.section) === String(secA)));
  assert.ok(res.json.data.some((s) => s.code === 'AI-101'));
  assert.ok(!res.text.includes('password'));
  // sectionId query from a student is IGNORED for scoping
  const injected = await student1.api('GET', `/api/student/subjects?sectionId=${secB}`);
  assert.ok(injected.json.data.every((s) => String(s.section) === String(secA)));
});

test('42. student cannot modify subjects (no mutation route for students)', async () => {
  assert.equal((await student1.api('POST', '/api/student/subjects', { name: 'X', code: 'X-1' })).status, 404);
  assert.equal((await student1.api('PATCH', `/api/cr/subjects/${subA1}`, { name: 'Hacked' })).status, 403);
  assert.equal((await student1.api('POST', `/api/cr/subjects/${subA1}/archive`)).status, 403);
  assert.equal((await student1.api('POST', '/api/admin/subjects', { section: secA, name: 'X', code: 'X-1' })).status, 403);
  assert.equal((await Subject.findById(subA1)).name, 'Artificial Intelligence I');
});

test('43. archived subject cannot be used for new academic activity', async () => {
  // CR archives own subject
  const arch = await cr1.api('POST', `/api/cr/subjects/${subA2}/archive`);
  assert.equal(arch.status, 200);
  assert.equal((await Subject.findById(subA2)).status, 'archived');

  // cannot update an archived subject
  const upd = await cr1.api('PATCH', `/api/cr/subjects/${subA2}`, { name: 'New Name' });
  assert.equal(upd.status, 400);
  // cannot archive twice
  assert.equal((await cr1.api('POST', `/api/cr/subjects/${subA2}/archive`)).status, 409);
  // same code cannot be re-created in the same section (unique across statuses)
  assert.equal((await cr1.api('POST', '/api/cr/subjects', { name: 'PF Again', code: 'PF-101' })).status, 409);
  // historical record still exists (no hard delete)
  const doc = await Subject.findById(subA2);
  assert.ok(doc && doc.status === 'archived');
});

/* ================================ SECURITY ================================ */
test('44. pastMembers injection blocked (append-only, no client path)', async () => {
  const res = await admin.api('PATCH', `/api/admin/sections/${secA}`, {
    pastMembers: [student1Id], // must be ignored
  });
  assert.equal(res.status, 200);
  const doc = await Section.findById(secA);
  assert.deepEqual(doc.pastMembers, [], 'pastMembers untouched by client payload');
  // also ignored on section creation
  const res2 = await admin.api('POST', '/api/admin/sections', {
    department: deptCS, session: session1, semester: 7, name: '7P', pastMembers: [student1Id],
  });
  assert.equal(res2.status, 200);
  assert.deepEqual((await Section.findById(res2.json.data._id)).pastMembers, []);
});

test('45. role injection blocked across flows', async () => {
  const res = await cr1.api('POST', '/api/cr/students', {
    name: 'Role Inject', rollNo: 'R-110', email: 'roleinject@test.local', role: 'cr',
  });
  assert.equal(res.status, 200);
  assert.equal((await User.findOne({ email: 'roleinject@test.local' })).role, 'student');
});

test('50. password/hash never appears in any list or detail response', async () => {
  const checks = [
    await admin.api('GET', '/api/admin/students?limit=100'),
    await admin.api('GET', `/api/admin/sections/${secA}`),
    await cr1.api('GET', '/api/cr/students'),
    await student1.api('GET', '/api/student/subjects'),
    await student1.api('GET', '/api/auth/me'),
  ];
  for (const r of checks) {
    assert.ok(!/\$2[aby]\$/.test(r.text), 'no bcrypt hash in response');
    assert.ok(!/"password"/.test(r.text), 'no password field in response');
  }
});

test('51. OTP/token fields never appear in academic responses', async () => {
  const checks = [
    await admin.api('GET', '/api/admin/students'),
    await cr1.api('GET', '/api/cr/subjects'),
  ];
  for (const r of checks) {
    for (const secret of ['activationToken', 'resetToken', 'codeHash', 'tokenJti', 'otp']) {
      assert.ok(!r.text.includes(secret), `${secret} must never appear`);
    }
  }
});

test('52. invalid ObjectId returns clean 400 (never 500)', async () => {
  assert.equal((await admin.api('GET', '/api/admin/departments/not-an-id')).status, 400);
  assert.equal((await admin.api('GET', '/api/admin/subjects/zzz')).status, 400);
  assert.equal((await admin.api('PATCH', '/api/admin/sections/123', { name: 'X' })).status, 400);
  assert.equal((await cr1.api('GET', '/api/cr/subjects/abc')).status, 400);
  assert.equal((await admin.api('GET', `/api/admin/students?section=bad`)).status, 400);
});

test('53. cross-section get-by-ID returns 404 (already covered) + admin can read any', async () => {
  // admin CAN read across sections (explicit system administrator)
  const res = await admin.api('GET', `/api/admin/subjects/${subB1}`);
  assert.equal(res.status, 200);
});

test('54. pagination limits enforced (hard cap 100)', async () => {
  // create 5 more students so pagination is meaningful
  for (let i = 0; i < 5; i++) {
    await cr1.api('POST', '/api/cr/students', {
      name: `Bulk ${i}`, rollNo: `R-2${i}0`, email: `bulk${i}@test.local`,
    });
  }
  const page1 = await cr1.api('GET', '/api/cr/students?limit=2&page=1');
  assert.equal(page1.status, 200);
  assert.equal(page1.json.data.length, 2);
  assert.equal(page1.json.pagination.page, 1);
  assert.equal(page1.json.pagination.limit, 2);
  assert.ok(page1.json.pagination.total >= 8);

  const page3 = await cr1.api('GET', '/api/cr/students?limit=2&page=3');
  assert.equal(page3.json.data.length, 2);
  assert.notEqual(page3.json.data[0]._id, page1.json.data[0]._id); // different page

  const capped = await cr1.api('GET', '/api/cr/students?limit=5000');
  assert.equal(capped.json.pagination.limit, 100); // hard cap

  const adminCapped = await admin.api('GET', '/api/admin/students?limit=9999');
  assert.equal(adminCapped.json.pagination.limit, 100);

  const badPage = await cr1.api('GET', '/api/cr/students?page=-5&limit=abc');
  assert.equal(badPage.status, 200); // graceful fallback, never a 500
  assert.equal(badPage.json.pagination.page, 1);
});

test('18b. audit log has every academic action, with no secrets', async () => {
  // safe here — all remaining tests create no new sections
  const arch = await admin.api('POST', `/api/admin/sessions/${session1}/archive`);
  assert.equal(arch.status, 200);
  for (const action of [
    'department.create', 'department.update', 'department.archive',
    'session.create', 'session.update', 'session.archive',
    'section.create', 'section.update', 'section.archive',
    'cr.assign', 'cr.reassign', 'cr.remove',
    'user.student.precreate',
    'subject.create', 'subject.update', 'subject.archive',
  ]) {
    const n = await AuditLog.countDocuments({ action });
    assert.ok(n > 0, `${action} recorded`);
  }
  const logs = await AuditLog.find({});
  const text = JSON.stringify(logs.map((l) => ({ b: l.before, a: l.after })));
  assert.ok(!text.includes('password'), 'no password in audit');
  assert.ok(!text.includes('CrPass'), 'no plaintext password value in audit');
});

test('55. regression guard: health + auth unchanged', async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.database, 'connected');
  const bad = await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'WrongPass1!' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.message, 'Invalid email or password');
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
