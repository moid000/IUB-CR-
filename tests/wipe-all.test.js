/**
 * Danger-zone wipe tests — POST /api/admin/wipe-all.
 * Covers: auth guard (401/403), confirm phrase guard (400), full cascade
 * (every content collection + CR/student accounts emptied, admin survives,
 * audit entry written), idempotency on an already-empty database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('wipe_test');
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

const {
  User, Department, AcademicSession, Section, Subject, Announcement, Note,
  Assignment, Submission, Timetable, Assessment, Mark, Notification, AuditLog, Otp,
} = models;
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
const cr = makeSession();
const student = makeSession();

test('fixtures: full hierarchy + content', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  const dept = (await must(admin.api('POST', '/api/admin/departments', { name: 'AI', code: 'AI' }), 'dept'));
  const sess = (await must(admin.api('POST', '/api/admin/sessions', { name: 'Fall 2026' }), 'sess'));
  const sec = (await must(admin.api('POST', '/api/admin/sections', { department: dept, session: sess, semester: 1, name: '1M' }), 'sec'));

  const hash = await bcrypt.hash('Pass1234!', 10);
  const crId = await User.create({
    name: 'Demo CR', email: 'wipe-cr@test.local', phone: '+923001110011',
    role: 'cr', registrationStatus: 'active', emailVerified: true, password: hash, section: sec,
  }).then((u) => u._id);
  await User.create({
    name: 'Demo Student', email: 'wipe-s@test.local', phone: '+923001110022',
    role: 'student', registrationStatus: 'active', emailVerified: true, password: hash,
    section: sec, rollNo: 'S-001',
  });
  await Section.updateOne({ _id: sec }, { $set: { cr: crId } });

  const sub = (await must(admin.api('POST', '/api/admin/subjects', { section: sec, name: 'Intro to AI', code: 'AI-101' }), 'sub'));

  assert.equal((await cr.api('POST', '/api/auth/login', { email: 'wipe-cr@test.local', password: 'Pass1234!' })).status, 200);
  assert.equal((await student.api('POST', '/api/auth/login', { email: 'wipe-s@test.local', password: 'Pass1234!' })).status, 200);

  await must(cr.api('POST', '/api/cr/announcements', { title: 'Welcome', content: 'First post.' }), 'ann');
  await must(cr.api('POST', '/api/cr/notes', { title: 'Ch 1', content: 'Read it.', subject: sub }), 'note');
  const asg = (await cr.api('POST', '/api/cr/assignments', {
    subject: sub, title: 'Task 1', instructions: 'Do it.',
    deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  })).json.data._id;
  await must(cr.api('POST', '/api/cr/timetable', { subject: sub, date: '2026-10-05', startTime: '10:00', endTime: '11:00' }), 'slot');
  await must(cr.api('POST', '/api/cr/assessments', {
    subject: sub, title: 'Quiz 1', type: 'quiz', totalMarks: 20,
    assessmentDate: '2026-09-20T09:00:00.000Z',
  }), 'quiz');
  assert.equal((await student.api('POST', `/api/student/assignments/${asg}/submission`, { textAnswer: 'My solution.' })).status, 200);
});

test('W1. wipe requires authentication — 401 without a session', async () => {
  const anon = makeSession();
  const res = await anon.api('POST', '/api/admin/wipe-all', { confirm: 'DELETE' });
  assert.equal(res.status, 401);
});

test('W2. wipe is admin-only — CR gets 403 and data survives', async () => {
  const res = await cr.api('POST', '/api/admin/wipe-all', { confirm: 'DELETE' });
  assert.equal(res.status, 403);
  assert.ok((await User.countDocuments({ role: 'cr' })) === 1);
  assert.ok((await Department.countDocuments()) === 1);
});

test('W3. wrong/missing confirm phrase → 400, nothing deleted', async () => {
  assert.equal((await admin.api('POST', '/api/admin/wipe-all')).status, 400);
  assert.equal((await admin.api('POST', '/api/admin/wipe-all', { confirm: 'delete' })).status, 400);
  assert.equal((await admin.api('POST', '/api/admin/wipe-all', { confirm: 'RESET' })).status, 400);
  assert.equal((await Department.countDocuments()), 1, 'departments untouched');
  assert.equal((await User.countDocuments({ role: 'student' })), 1, 'students untouched');
});

test('W4. confirmed wipe empties everything except admins + audit logs', async () => {
  const res = await admin.api('POST', '/api/admin/wipe-all', { confirm: 'DELETE' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.success, true);
  assert.ok(res.json.data.deleted, 'deleted counts returned');
  assert.deepEqual(res.json.data.kept, ['admin accounts', 'audit logs']);

  const zero = async (model, label) => assert.equal(await model.countDocuments({}), 0, `${label} emptied`);
  await zero(Department, 'departments');
  await zero(AcademicSession, 'sessions');
  await zero(Section, 'sections');
  await zero(Subject, 'subjects');
  await zero(Announcement, 'announcements');
  await zero(Note, 'notes');
  await zero(Assignment, 'assignments');
  await zero(Submission, 'submissions');
  await zero(Timetable, 'timetable');
  await zero(Assessment, 'assessments');
  await zero(Mark, 'marks');
  await zero(Notification, 'notifications');
  await zero(Otp, 'otps');

  const users = await User.find();
  assert.equal(users.length, 1, 'only the admin account survives');
  assert.equal(users[0].role, 'admin');

  const audit = await AuditLog.findOne({ action: 'system.wipe' });
  assert.ok(audit, 'wipe is audited');
});

test('W5. after the wipe the admin still logs in, CR and students cannot', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  const gone = makeSession();
  assert.equal((await gone.api('POST', '/api/auth/login', { email: 'wipe-cr@test.local', password: 'Pass1234!' })).status, 401);
  assert.equal((await gone.api('POST', '/api/auth/login', { email: 'wipe-s@test.local', password: 'Pass1234!' })).status, 401);
});

test('W6. wiping an already-empty system succeeds with zero counts', async () => {
  const res = await admin.api('POST', '/api/admin/wipe-all', { confirm: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.deleted.departments, 0);
  assert.equal(res.json.data.deleted.crAndStudentAccounts, 0);
});

test('cleanup', async () => {
  await mongoose.disconnect();
  await mongod.stop();
  server.close();
});
