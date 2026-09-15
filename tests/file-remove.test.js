/**
 * STEP 18 tests — attachment REMOVAL (POST /api/<role>/files/remove).
 * The same role matrix as sign/confirm applies: CRs act on their own
 * section's content, students only on their own submissions, admins act
 * cross-section but never on submissions. Removal is idempotent-safe
 * (404 once gone) and never touches other files on the same parent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('fileremove_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret';

const CLOUD_NAME = 'test-cloud-xyz';
const API_KEY = '123456789012345';
const API_SECRET = 'fake-api-secret-abcdef';
process.env.CLOUDINARY_CLOUD_NAME = CLOUD_NAME;
process.env.CLOUDINARY_API_KEY = API_KEY;
process.env.CLOUDINARY_API_SECRET = API_SECRET;

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { User, Section, Announcement, Submission } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const ROLE_PATH = { admin: '/api/admin', cr: '/api/cr', student: '/api/student' };

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
const cr1 = makeSession(); // section A
const cr2 = makeSession(); // section B
const s1 = makeSession();  // section A student
const s2 = makeSession();  // section A student

let secA, secB, annA1, s1SubmissionId, s2SubmissionId;
let annFiles = [];
const PDF = { originalName: 'doc.pdf', mimeType: 'application/pdf' };

async function confirmFile(session, role, parentType, parentId, name = 'doc.pdf') {
  const sign = (await session.api('POST', `${ROLE_PATH[role]}/files/sign`, {
    parentType, parentId, file: PDF,
  })).json.data;
  assert.ok(sign, 'sign succeeded');
  const result = {
    public_id: sign.publicId, folder: sign.folder,
    secure_url: `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/${sign.publicId}.pdf`,
    resource_type: 'raw', format: 'pdf', bytes: 2048, original_filename: name,
  };
  const r = await session.api('POST', `${ROLE_PATH[role]}/files/confirm`, { parentType, parentId, result });
  assert.equal(r.status, 200, 'confirm succeeded');
  return result;
}

const removeFile = (session, role, body) => session.api('POST', `${ROLE_PATH[role]}/files/remove`, body);

test('fixtures: hierarchy, parents with confirmed attachments', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  const dept = (await admin.api('POST', '/api/admin/departments', { name: 'CS', code: 'CS' })).json.data._id;
  const sess = (await admin.api('POST', '/api/admin/sessions', { name: '2027–28' })).json.data._id;
  secA = (await admin.api('POST', '/api/admin/sections', { department: dept, session: sess, semester: 5, name: '5A' })).json.data._id;
  secB = (await admin.api('POST', '/api/admin/sections', { department: dept, session: sess, semester: 5, name: '5B' })).json.data._id;

  const hash = await bcrypt.hash('Pass1234!', 10);
  const mk = (name, email, role, section, extra = {}) => User.create({
    name, email, role, registrationStatus: 'active', emailVerified: true, password: hash, section, ...extra,
  }).then((u) => u._id);
  const cr1Id = await mk('CR One', 'fr-cr1@test.local', 'cr', secA, { status: 'active' });
  const cr2Id = await mk('CR Two', 'fr-cr2@test.local', 'cr', secB);
  const s1Id = await mk('Student One', 'fr-s1@test.local', 'student', secA, { rollNo: 'F-001' });
  const s2Id = await mk('Student Two', 'fr-s2@test.local', 'student', secA, { rollNo: 'F-002' });
  await Section.updateOne({ _id: secA }, { $set: { cr: cr1Id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });

  const subA1 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' })).json.data._id;

  for (const [sess_, email] of [[cr1, 'fr-cr1@test.local'], [cr2, 'fr-cr2@test.local'], [s1, 'fr-s1@test.local'], [s2, 'fr-s2@test.local']]) {
    assert.equal((await sess_.api('POST', '/api/auth/login', { email, password: 'Pass1234!' })).status, 200, email);
  }

  annA1 = (await cr1.api('POST', '/api/cr/announcements', { title: 'Welcome', content: 'First post.' })).json.data._id;
  annFiles = [
    await confirmFile(cr1, 'cr', 'announcement', annA1, 'one.pdf'),
    await confirmFile(cr1, 'cr', 'announcement', annA1, 'two.pdf'),
  ];

  const asg = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Task 1', instructions: 'Do it.',
    deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  });
  const aA1 = asg.json.data._id;
  s1SubmissionId = (await s1.api('POST', `/api/student/assignments/${aA1}/submission`, { textAnswer: 'sol 1' })).json.data._id;
  s2SubmissionId = (await s2.api('POST', `/api/student/assignments/${aA1}/submission`, { textAnswer: 'sol 2' })).json.data._id;
  await confirmFile(s1, 'student', 'submission', s1SubmissionId, 'mine.pdf');
});

test('B1. unauthenticated remove → 401', async () => {
  assert.equal((await makeSession().api('POST', '/api/cr/files/remove', {
    parentType: 'announcement', parentId: annA1, publicId: annFiles[0].public_id,
  })).status, 401);
});

test('B2. CR removes own-section attachment — siblings intact', async () => {
  const before = (await cr1.api('GET', `/api/cr/announcements/${annA1}`)).json.data.attachments;
  assert.equal(before.length, 2);
  const r = await removeFile(cr1, 'cr', { parentType: 'announcement', parentId: annA1, publicId: annFiles[0].public_id });
  assert.equal(r.status, 200);
  const after = (await cr1.api('GET', `/api/cr/announcements/${annA1}`)).json.data.attachments;
  assert.equal(after.length, 1);
  assert.equal(after[0].originalName, 'two.pdf');
});

test('B3. cross-section CR remove → 404 (isolation, no existence leak)', async () => {
  const annB = (await cr2.api('POST', '/api/cr/announcements', { title: 'B only', content: 'x' })).json.data._id;
  await confirmFile(cr2, 'cr', 'announcement', annB, 'b.pdf');
  const bFiles = (await cr2.api('GET', `/api/cr/announcements/${annB}`)).json.data.attachments;
  // cr1 (section A) tries to remove cr2's (section B) file
  const r = await removeFile(cr1, 'cr', { parentType: 'announcement', parentId: annB, publicId: bFiles[0].publicId });
  assert.equal(r.status, 404);
});

test('B4. student removes ONLY own submission files; wrong submission → 404', async () => {
  const myFiles = (await s1.api('GET', `/api/student/assignments/${(await Submission.findById(s1SubmissionId)).assignment}/submission`)).json.data.files;
  assert.equal(myFiles.length, 1);
  const r = await removeFile(s1, 'student', { parentType: 'submission', parentId: s1SubmissionId, publicId: myFiles[0].publicId });
  assert.equal(r.status, 200);
  // s1 now tries to remove a file from s2's submission → 404 (isolation)
  const s2Files = (await s2.api('GET', `/api/student/assignments/${(await Submission.findById(s2SubmissionId)).assignment}/submission`)).json.data;
  const graft = await removeFile(s1, 'student', { parentType: 'submission', parentId: s2SubmissionId, publicId: s2Files.length ? s2Files[0].publicId : 'whatever' });
  assert.equal(graft.status, 404);
});

test('B5. CR may never remove submission files; admin neither', async () => {
  await confirmFile(s2, 'student', 'submission', s2SubmissionId, 's2.pdf');
  const s2Files = (await s2.api('GET', `/api/student/assignments/${(await Submission.findById(s2SubmissionId)).assignment}/submission`)).json.data.files;
  const target = s2Files[0].publicId;
  assert.equal((await removeFile(cr1, 'cr', { parentType: 'submission', parentId: s2SubmissionId, publicId: target })).status, 403);
  assert.equal((await removeFile(admin, 'admin', { parentType: 'submission', parentId: s2SubmissionId, publicId: target })).status, 403);
});

test('B6. student may not remove announcement attachments', async () => {
  const r = await removeFile(s1, 'student', { parentType: 'announcement', parentId: annA1, publicId: annFiles[1].public_id });
  assert.equal(r.status, 403);
});

test('B7. unknown publicId / bad parentType / bad ids → 404/400', async () => {
  assert.equal((await removeFile(cr1, 'cr', { parentType: 'announcement', parentId: annA1, publicId: 'nope' })).status, 404);
  assert.equal((await removeFile(cr1, 'cr', { parentType: 'evil', parentId: annA1, publicId: 'x' })).status, 400);
  assert.equal((await removeFile(cr1, 'cr', { parentType: 'announcement', parentId: 'not-an-id', publicId: 'x' })).status, 400);
});

test('B8. double remove → second is 404 (idempotent-safe)', async () => {
  assert.equal((await removeFile(cr1, 'cr', { parentType: 'announcement', parentId: annA1, publicId: annFiles[1].public_id })).status, 200);
  assert.equal((await removeFile(cr1, 'cr', { parentType: 'announcement', parentId: annA1, publicId: annFiles[1].public_id })).status, 404);
  const doc = await Announcement.findById(annA1);
  assert.equal(doc.attachments.length, 0);
});

test('B9. no secrets in any remove response; audit written', async () => {
  const f = await confirmFile(cr1, 'cr', 'announcement', annA1, 'audit.pdf');
  const r = await removeFile(cr1, 'cr', { parentType: 'announcement', parentId: annA1, publicId: f.public_id });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(API_SECRET), 'api secret never appears');
  const AuditLog = models.AuditLog;
  const ev = await AuditLog.findOne({ action: 'file.upload.remove' }).lean();
  assert.ok(ev, 'remove audit event exists');
  assert.ok(!JSON.stringify(ev).includes(API_SECRET));
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
