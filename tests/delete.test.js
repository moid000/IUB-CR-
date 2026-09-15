/**
 * DELETE feature tests — hard delete for every entity the UI exposes.
 * Covers: content (announcements/notes/assignments/timetable/assessments),
 * subjects (with dependents guard), structural (department/session/section
 * with dependents guard), and users (CR/student with cascade cleanup).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('delete_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud-xyz';
process.env.CLOUDINARY_API_KEY = '123456789012345';
process.env.CLOUDINARY_API_SECRET = 'fake-api-secret-abcdef';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Section, Announcement, Note, Assignment, Submission, Timetable, Assessment, Mark, Notification } = models;
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

const must = async (resP, label) => {
  const res = await resP;
  if (res?.status !== 200) throw new Error(`FIXTURE ${label} -> ${res?.status}: ${JSON.stringify(res?.json)}`);
  return res.json.data._id;
};

const admin = makeSession();
const cr1 = makeSession(); // section A
const cr2 = makeSession(); // section B
const s1 = makeSession();  // section A student

let dept1, dept2, sess1, secA, secB, secEmpty, subA, subB;
let cr1Id, cr2Id, s1Id, annA, noteA, noteB, asgA, slotA, quizA;

test('fixtures: full hierarchy + content', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  dept1 = (await must(admin.api('POST', '/api/admin/departments', { name: 'CS', code: 'CS' }), 'dept1'));
  dept2 = (await must(admin.api('POST', '/api/admin/departments', { name: 'AI', code: 'AI' }), 'dept2'));
  sess1 = (await must(admin.api('POST', '/api/admin/sessions', { name: '2026-27' }), 'sess1'));
  secA = (await must(admin.api('POST', '/api/admin/sections', { department: dept1, session: sess1, semester: 5, name: '5A' }), 'secA'));
  secB = (await must(admin.api('POST', '/api/admin/sections', { department: dept1, session: sess1, semester: 5, name: '5B' }), 'secB'));
  secEmpty = (await must(admin.api('POST', '/api/admin/sections', { department: dept2, session: sess1, semester: 1, name: '1Z' }), 'secEmpty'));

  const hash = await bcrypt.hash('Pass1234!', 10);
  const mk = (name, email, role, section, extra = {}) => User.create({
    name, email, phone: '+9230011100' + Math.floor(Math.random() * 900 + 99),
    role, registrationStatus: 'active', emailVerified: true, password: hash, section, status: 'active', ...extra,
  }).then((u) => u._id);
  cr1Id = await mk('CR One', 'del-cr1@test.local', 'cr', secA);
  cr2Id = await mk('CR Two', 'del-cr2@test.local', 'cr', secB);
  s1Id = await mk('Student One', 'del-s1@test.local', 'student', secA, { rollNo: 'F-001' });
  await Section.updateOne({ _id: secA }, { $set: { cr: cr1Id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });

  subA = (await must(admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' }), 'subA'));
  subB = (await must(admin.api('POST', '/api/admin/subjects', { section: secB, name: 'Networks', code: 'NW-101' }), 'subB'));

  for (const [sess_, email] of [[cr1, 'del-cr1@test.local'], [cr2, 'del-cr2@test.local'], [s1, 'del-s1@test.local']]) {
    assert.equal((await sess_.api('POST', '/api/auth/login', { email, password: 'Pass1234!' })).status, 200, email);
  }

  annA = (await must(cr1.api('POST', '/api/cr/announcements', { title: 'Welcome', content: 'First post.' }), 'cr1'));
  noteA = (await must(cr1.api('POST', '/api/cr/notes', { title: 'Notes', content: 'Ch 1.', subject: subA }), 'cr1'));
  noteB = (await must(cr2.api('POST', '/api/cr/notes', { title: 'B notes', content: 'B.', subject: subB }), 'cr2'));
  asgA = (await cr1.api('POST', '/api/cr/assignments', {
    subject: subA, title: 'Task 1', instructions: 'Do it.',
    deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  })).json.data._id;
  slotA = (await must(cr1.api('POST', '/api/cr/timetable', { subject: subA, day: 'monday', startTime: '10:00', endTime: '11:00' }), 'cr1'));
  quizA = (await must(cr1.api('POST', '/api/cr/assessments', {
    subject: subA, title: 'Quiz 1', type: 'quiz', totalMarks: 20,
    assessmentDate: '2026-09-20T09:00:00.000Z',
  }), 'cr1'));

  assert.equal((await s1.api('POST', `/api/student/assignments/${asgA}/submission`, { textAnswer: 'My solution.' })).status, 200);
});

/* --------------------------- A. UNAUTHENTICATED --------------------------- */
test('A1. every delete route returns 401 without a session', async () => {
  const anon = makeSession();
  const paths = [
    '/api/admin/departments/x', '/api/admin/sessions/x', '/api/admin/sections/x',
    '/api/admin/crs/x', '/api/admin/students/x', '/api/admin/subjects/x',
    '/api/admin/announcements/x', '/api/admin/assignments/x',
    '/api/admin/timetable/x', '/api/admin/notes/x', '/api/admin/assessments/x',
    '/api/cr/announcements/x', '/api/cr/notes/x', '/api/cr/assignments/x',
    '/api/cr/timetable/x', '/api/cr/subjects/x', '/api/cr/assessments/x',
  ];
  for (const p of paths) assert.equal((await anon.api('DELETE', p)).status, 401, p);
});

/* ------------------------- B. SECTION-CONTENT (CR) ------------------------- */
test('B1. CR deletes own announcement — doc + notifications gone', async () => {
  const res = await cr1.api('DELETE', `/api/cr/announcements/${annA}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.deleted, true);
  assert.equal(await Announcement.countDocuments({ _id: annA }), 0);
  assert.equal(await Notification.countDocuments({ refType: 'Announcement', refId: annA }), 0);
});

test('B2. cross-section delete returns 404 (no existence leak)', async () => {
  assert.equal((await cr1.api('DELETE', `/api/cr/notes/${noteB}`)).status, 404);
});

test('B3. student may never call delete routes', async () => {
  assert.equal((await s1.api('DELETE', `/api/cr/announcements/${noteA}`)).status, 403);
  assert.equal((await s1.api('DELETE', `/api/cr/notes/${noteA}`)).status, 403);
  assert.equal((await s1.api('DELETE', `/api/cr/assignments/${asgA}`)).status, 403);
});

test('B4. CR deletes own note', async () => {
  assert.equal((await cr1.api('DELETE', `/api/cr/notes/${noteA}`)).status, 200);
  assert.equal(await Note.countDocuments({ _id: noteA }), 0);
});

test('B5. CR deletes own assignment — submissions cascade', async () => {
  assert.equal(await Submission.countDocuments({ assignment: asgA }), 1);
  const res = await cr1.api('DELETE', `/api/cr/assignments/${asgA}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.submissionsRemoved, 1);
  assert.equal(await Submission.countDocuments({ assignment: asgA }), 0);
  assert.equal(await Assignment.countDocuments({ _id: asgA }), 0);
});

test('B6. CR deletes own timetable slot', async () => {
  assert.equal((await cr1.api('DELETE', `/api/cr/timetable/${slotA}`)).status, 200);
  assert.equal(await Timetable.countDocuments({ _id: slotA }), 0);
});

test('B7. CR deletes own assessment', async () => {
  assert.equal((await cr1.api('DELETE', `/api/cr/assessments/${quizA}`)).status, 200);
  assert.equal(await Assessment.countDocuments({ _id: quizA }), 0);
});

test('B8. admin can delete any section content via admin routes', async () => {
  const ann2 = (await must(cr2.api('POST', '/api/cr/announcements', { title: 'B ann', content: 'x.' }), 'cr2'));
  assert.equal((await admin.api('DELETE', `/api/admin/announcements/${ann2}`)).status, 200);
  const note2 = (await must(cr2.api('POST', '/api/cr/notes', { title: 'B note', content: 'x.', subject: subB }), 'cr2'));
  assert.equal((await admin.api('DELETE', `/api/admin/notes/${note2}`)).status, 200);
});

/* --------------------------- C. SUBJECTS (guards) --------------------------- */
test('C1. subject delete blocked while dependents exist; succeeds once cleared', async () => {
  const asg = (await cr1.api('POST', '/api/cr/assignments', {
    subject: subA, title: 'Task 2', instructions: 'x.',
    deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  })).json.data._id;
  const blocked = await admin.api('DELETE', `/api/admin/subjects/${subA}`);
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.message, /assignment/);
  assert.equal((await cr1.api('DELETE', `/api/cr/assignments/${asg}`)).status, 200);
  assert.equal((await admin.api('DELETE', `/api/admin/subjects/${subA}`)).status, 200);
});

test('C2. CR deletes own empty subject; cross-section stays 404', async () => {
  assert.equal((await cr1.api('DELETE', `/api/cr/subjects/${subB}`)).status, 404);
  const subA2 = (await must(cr1.api('POST', '/api/cr/subjects', { name: 'OS', code: 'OS-301' }), 'cr1'));
  assert.equal((await cr1.api('DELETE', `/api/cr/subjects/${subA2}`)).status, 200);
});

/* -------------------- D. STRUCTURAL GUARDS -------------------- */
test('D1. department delete blocked while sections exist', async () => {
  const res = await admin.api('DELETE', `/api/admin/departments/${dept1}`);
  assert.equal(res.status, 400);
  assert.match(res.json.message, /section/);
});

test('D2. session delete blocked while sections exist', async () => {
  assert.match((await admin.api('DELETE', `/api/admin/sessions/${sess1}`)).json.message, /section/);
});

test('D3. section delete blocked with CR/students; empty section deletes cleanly', async () => {
  const res = await admin.api('DELETE', `/api/admin/sections/${secA}`);
  assert.equal(res.status, 400);
  assert.match(res.json.message, /CR/);
  assert.equal((await admin.api('DELETE', `/api/admin/sections/${secEmpty}`)).status, 200);
});

/* --------------------------- E. USERS (cascade) --------------------------- */
test('E1. student delete cascades submissions + marks + notifications', async () => {
  const subA3 = (await must(cr1.api('POST', '/api/cr/subjects', { name: 'AI', code: 'AI-401' }), 'cr1'));
  const asg = (await cr1.api('POST', '/api/cr/assignments', {
    subject: subA3, title: 'Final task', instructions: 'x.',
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
  })).json.data._id;
  assert.equal((await s1.api('POST', `/api/student/assignments/${asg}/submission`, { textAnswer: 'work' })).status, 200);
  assert.equal(await Submission.countDocuments({ student: s1Id }), 1);

  const res = await admin.api('DELETE', `/api/admin/students/${s1Id}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.submissionsRemoved, 1);
  assert.equal(await User.countDocuments({ _id: s1Id }), 0);
  assert.equal(await Submission.countDocuments({ student: s1Id }), 0);
  assert.equal(await Mark.countDocuments({ student: s1Id }), 0);
  assert.equal(await Notification.countDocuments({ recipient: s1Id }), 0);
  assert.equal((await admin.api('DELETE', `/api/admin/assignments/${asg}`)).status, 200);
});

test('E2. CR delete unlinks section.cr and removes the account', async () => {
  const res = await admin.api('DELETE', `/api/admin/crs/${cr2Id}`);
  assert.equal(res.status, 200);
  const sec = await Section.findById(secB);
  assert.ok(!sec.cr, 'section.cr should be unset');
  assert.equal(await User.countDocuments({ _id: cr2Id }), 0);
});

test('E3. clearing a section bottom-up unblocks section delete', async () => {
  assert.equal((await admin.api('DELETE', `/api/admin/crs/${cr1Id}`)).status, 200);
  assert.equal((await admin.api('DELETE', `/api/admin/notes/${noteB}`)).status, 200);
  const leftovers = await models.Subject.find({ section: { $in: [secA, secB] } });
  for (const subj of leftovers) {
    const r = await admin.api('DELETE', `/api/admin/subjects/${subj._id}`);
    assert.ok(r.status === 200, `subject ${subj.name}: ${r.json?.message}`);
  }
  assert.equal((await admin.api('DELETE', `/api/admin/sections/${secA}`)).status, 200);
  assert.equal((await admin.api('DELETE', `/api/admin/sections/${secB}`)).status, 200);
});

/* --------------------------- F. FULL BOTTOM-UP CHAIN --------------------------- */
test('F1. emptied session + departments delete cleanly', async () => {
  assert.equal((await admin.api('DELETE', `/api/admin/sessions/${sess1}`)).status, 200);
  assert.equal((await admin.api('DELETE', `/api/admin/departments/${dept1}`)).status, 200);
  assert.equal((await admin.api('DELETE', `/api/admin/departments/${dept2}`)).status, 200);
  assert.equal(await Section.countDocuments({}), 0);
});

test('F2. invalid ids return 400, unknown ids return 404', async () => {
  assert.equal((await admin.api('DELETE', '/api/admin/departments/zzz')).status, 400);
  assert.equal((await admin.api('DELETE', `/api/admin/departments/${new mongoose.Types.ObjectId()}`)).status, 404);
  assert.equal((await admin.api('DELETE', `/api/admin/crs/${new mongoose.Types.ObjectId()}`)).status, 404);
});

test('shutdown', async () => {
  await mongoose.disconnect();
  await mongod.stop();
  server.close();
});
