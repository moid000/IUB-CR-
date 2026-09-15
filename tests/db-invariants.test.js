/**
 * Database & security invariant tests.
 * Runs against an in-memory MongoDB — production Atlas is NEVER touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Required by backend/config/env.js ensureEnv() when app.js is imported (test 15).
// Placeholder only — the app is never given requests in these tests; the real
// connection below uses the in-memory MongoDB URI.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/test-only';
process.env.NODE_ENV = 'test';

const { MongoMemoryServer } = await import('mongodb-memory-server');
const { default: mongoose } = await import('mongoose');

const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const {
  User, Department, AcademicSession, Section, Subject, Announcement, Note,
  Assignment, Submission, Timetable, AttendanceSession, AttendanceRecord,
  Notification, Otp, AuditLog,
} = models;

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('iubcr_test');
  await mongoose.connect(mongod.getUri('iubcr_test'));
  // Ensure all unique/partial indexes are built before any inserts
  await Promise.all(
    Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init())
  );
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const oid = () => new mongoose.Types.ObjectId();

// Shared fixture ids
const ctx = {};
test.before(async () => {
  ctx.dept = oid();
  ctx.sessionA = oid();
  ctx.sessionB = oid();
  ctx.sectionA = oid();
  ctx.sectionB = oid();
  ctx.cr = oid();
  ctx.student = oid();
  ctx.subject = oid();
});

const isDuplicateKey = (err) => err.code === 11000;

// ---------- 1. Duplicate User email rejected ----------
test('duplicate User email is rejected', async () => {
  await User.create({ name: 'A', email: 'same@example.com', role: 'cr' });
  await assert.rejects(
    () => User.create({ name: 'B', email: 'same@example.com', role: 'student' }),
    isDuplicateKey
  );
});

// ---------- 2. Duplicate student rollNo within same section rejected ----------
test('duplicate student rollNo within the same section is rejected', async () => {
  await User.create({ name: 'S1', email: 's1@example.com', role: 'student', section: ctx.sectionA, rollNo: 'F-101' });
  await assert.rejects(
    () => User.create({ name: 'S2', email: 's2@example.com', role: 'student', section: ctx.sectionA, rollNo: 'F-101' }),
    isDuplicateKey
  );
});

// ---------- 3. Same rollNo allowed in different sections ----------
test('the same rollNo is allowed in a different section', async () => {
  const s3 = await User.create({ name: 'S3', email: 's3@example.com', role: 'student', section: ctx.sectionB, rollNo: 'F-101' });
  assert.ok(s3._id);
});

// ---------- 4. Duplicate Section rejected ----------
test('duplicate Section (dept+session+semester+name) is rejected', async () => {
  const base = { department: ctx.dept, session: ctx.sessionA, semester: 3, name: '3m' };
  await Section.create(base);
  await assert.rejects(() => Section.create({ ...base }), isDuplicateKey);
});

// ---------- 5. Duplicate Subject code within same section rejected ----------
test('duplicate Subject code within the same section is rejected', async () => {
  await Subject.create({ name: 'DSA', code: 'cs-301', section: ctx.sectionA, createdBy: ctx.cr });
  await assert.rejects(
    () => Subject.create({ name: 'DSA Again', code: 'CS-301', section: ctx.sectionA, createdBy: ctx.cr }),
    isDuplicateKey
  );
});

// ---------- 6. Same Subject code allowed in different sections ----------
test('the same Subject code is allowed in a different section', async () => {
  const s = await Subject.create({ name: 'DSA', code: 'CS-301', section: ctx.sectionB, createdBy: ctx.cr });
  assert.ok(s._id);
});

// ---------- 7. Duplicate Submission for same assignment/student rejected ----------
test('duplicate Submission for the same assignment/student is rejected', async () => {
  const assignment = oid();
  await Submission.create({ assignment, student: ctx.student, section: ctx.sectionA });
  await assert.rejects(
    () => Submission.create({ assignment, student: ctx.student, section: ctx.sectionA, textAnswer: 'again' }),
    isDuplicateKey
  );
});

// ---------- 8. Duplicate AttendanceRecord for same session/student rejected ----------
test('duplicate AttendanceRecord for the same session/student is rejected', async () => {
  const session = oid();
  await AttendanceRecord.create({ session, student: ctx.student, section: ctx.sectionA });
  await assert.rejects(
    () => AttendanceRecord.create({ session, student: ctx.student, section: ctx.sectionA }),
    isDuplicateKey
  );
});

// ---------- 9. Duplicate notification dedupeKey for same recipient rejected ----------
test('duplicate notification dedupeKey for the same recipient is rejected', async () => {
  const key = 'reminder:slot1:2026-09-14';
  await Notification.create({ recipient: ctx.student, type: 'reminder', dedupeKey: key });
  await assert.rejects(
    () => Notification.create({ recipient: ctx.student, type: 'reminder', dedupeKey: key }),
    isDuplicateKey
  );
});

// ---------- 10. Different recipients may use the same dedupeKey ----------
test('different recipients may use the same notification dedupeKey', async () => {
  const key = 'reminder:slot2:2026-09-14';
  const other = oid();
  await Notification.create({ recipient: ctx.student, type: 'reminder', dedupeKey: key });
  const n2 = await Notification.create({ recipient: other, type: 'reminder', dedupeKey: key });
  assert.ok(n2._id);
});

// ---------- 11. More than one active AcademicSession rejected ----------
test('more than one active AcademicSession is rejected', async () => {
  await AcademicSession.create({ name: '2026–27', status: 'active' });
  await assert.rejects(
    () => AcademicSession.create({ name: '2027–28', status: 'active' }),
    isDuplicateKey
  );
  // archived sessions do not collide with the active one
  await AcademicSession.create({ name: '2025–26', status: 'archived' });
});

// ---------- 12. More than one CR assigned to the same Section rejected ----------
test('two Sections cannot reference the same CR', async () => {
  const dept2 = oid();
  await Section.create({ department: dept2, session: ctx.sessionA, semester: 1, name: '1M', cr: ctx.cr });
  await assert.rejects(
    () => Section.create({ department: dept2, session: ctx.sessionA, semester: 2, name: '2M', cr: ctx.cr }),
    isDuplicateKey
  );
});

// ---------- 13. Section.pastMembers accepts User references ----------
test('Section.pastMembers accepts User references (append-only roster history)', async () => {
  const dept3 = oid();
  const sec = await Section.create({
    department: dept3, session: ctx.sessionB, semester: 4, name: '4M',
    pastMembers: [ctx.student],
  });
  const found = await Section.findById(sec._id).lean();
  assert.equal(found.pastMembers.length, 1);
  assert.equal(String(found.pastMembers[0]), String(ctx.student));
});

// ---------- 14. Password is not returned in normal User queries ----------
test('password field is excluded from normal User queries', async () => {
  await User.create({ name: 'PW', email: 'pw@example.com', role: 'student', password: 'hashed-secret-value' });
  const user = await User.findOne({ email: 'pw@example.com' });
  assert.equal(user.password, undefined);
  const lean = await User.findOne({ email: 'pw@example.com' }).lean();
  assert.equal('password' in lean, false);
});

// ---------- 15. AuditLog has no update/delete API ----------
test('no audit-related update/delete routes exist on the API', async () => {
  function walk(stack, out = []) {
    for (const layer of stack || []) {
      if (layer.regexp?.source) out.push(layer.regexp.source);
      if (layer.handle?.stack) walk(layer.handle.stack, out);
    }
    return out;
  }
  const sources = walk(app._router.stack);
  assert.ok(sources.some((s) => s.includes('health')), 'health route exists');
  assert.ok(!sources.some((s) => s.includes('audit')), 'no audit routes are exposed');
  // AuditLog writes work (append-only usage)
  const log = await AuditLog.create({ actorRole: 'system', action: 'test.action' });
  assert.ok(log._id);
});

// ---------- Extra invariants ----------
test('timetable endTime must be after startTime', async () => {
  await assert.rejects(
    () => Timetable.create({
      section: ctx.sectionA, subject: ctx.subject, date: '2026-10-05',
      startTime: '10:00', endTime: '09:00', createdBy: ctx.cr,
    }),
    (err) => err.name === 'ValidationError'
  );
});

test('attendance session expiresAt must be after opensAt', async () => {
  const now = new Date();
  await assert.rejects(
    () => AttendanceSession.create({
      section: ctx.sectionA, subject: ctx.subject, createdBy: ctx.cr,
      date: now, opensAt: now, expiresAt: new Date(now.getTime() - 1000),
      codeHash: 'x'.repeat(64),
    }),
    (err) => err.name === 'ValidationError'
  );
});

test('single-active-session partial unique + archived section keeps history shape', async () => {
  const archived = await Section.create({
    department: oid(), session: ctx.sessionB, semester: 2, name: '2M', status: 'archived',
  });
  assert.equal(archived.status, 'archived');
});
