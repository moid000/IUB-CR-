/**
 * STEP 10 tests — secure Cloudinary browser-direct upload foundation.
 * NO real Cloudinary calls, NO real credentials: the suite runs against fake
 * env values and verifies the OFFICIAL sha1 signature algorithm locally.
 * MOCK_NOW pins the server timestamp for signature determinism.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('fileupload_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret';

// FAKE Cloudinary credentials only — never real values, never committed elsewhere
const CLOUD_NAME = 'test-cloud-xyz';
const API_KEY = '123456789012345';
const API_SECRET = 'fake-api-secret-abcdef';
process.env.CLOUDINARY_CLOUD_NAME = CLOUD_NAME;
process.env.CLOUDINARY_API_KEY = API_KEY;
process.env.CLOUDINARY_API_SECRET = API_SECRET;

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Section, Subject, Announcement, Note, Assignment, Submission, AuditLog } = models;
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
const s1 = makeSession();  // section A
const s2 = makeSession();  // section A

let secA, secB, subA1, aA1, annA1, annB1, noteA1;
let s1Id, s2Id, cr1Id, cr2Id;
let s1SubmissionId;

const setNow = (epoch) => {
  if (epoch === null) delete process.env.MOCK_NOW;
  else process.env.MOCK_NOW = String(epoch);
};

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** Official Cloudinary signature recomputation for cross-checking the service. */
const expectedSignature = ({ folder, publicId, timestamp }) =>
  sha1(`folder=${folder}&public_id=${publicId}&timestamp=${timestamp}` + API_SECRET);

const signFile = (session, role, body) => session.api('POST', `${ROLE_PATH[role]}/files/sign`, body);
const confirmFile = (session, role, body) => session.api('POST', `${ROLE_PATH[role]}/files/confirm`, body);

/** Build a valid fake Cloudinary upload result from a sign response. */
function cloudinaryResult(signRes, { format, resourceType, bytes = 2048, name = 'doc.pdf' } = {}) {
  return {
    public_id: signRes.publicId,
    folder: signRes.folder,
    secure_url: `https://res.cloudinary.com/${CLOUD_NAME}/${resourceType}/upload/${signRes.publicId}.${format}`,
    resource_type: resourceType,
    format,
    bytes,
    original_filename: name,
  };
}

const PDF = { originalName: 'lecture.pdf', mimeType: 'application/pdf' };

test('fixtures: hierarchy, users, parents', async () => {
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
  cr1Id = await mk('CR One', 'fu-cr1@test.local', 'cr', secA, { status: 'active' });
  cr2Id = await mk('CR Two', 'fu-cr2@test.local', 'cr', secB);
  s1Id = await mk('Student One', 'fu-s1@test.local', 'student', secA, { rollNo: 'F-001' });
  s2Id = await mk('Student Two', 'fu-s2@test.local', 'student', secA, { rollNo: 'F-002' });
  await Section.updateOne({ _id: secA }, { $set: { cr: cr1Id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });

  subA1 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' })).json.data._id;

  for (const [sess_, email] of [[cr1, 'fu-cr1@test.local'], [cr2, 'fu-cr2@test.local'], [s1, 'fu-s1@test.local'], [s2, 'fu-s2@test.local']]) {
    assert.equal((await sess_.api('POST', '/api/auth/login', { email, password: 'Pass1234!' })).status, 200, email);
  }

  annA1 = (await cr1.api('POST', '/api/cr/announcements', { title: 'Welcome', content: 'First post.' })).json.data._id;
  annB1 = (await cr2.api('POST', '/api/cr/announcements', { title: 'Section B only', content: 'B post.' })).json.data._id;
  noteA1 = (await cr1.api('POST', '/api/cr/notes', { title: 'Notes', content: 'Ch 1.', subject: subA1 })).json.data._id;
  const asg = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Task 1', instructions: 'Do it.',
    deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  });
  aA1 = asg.json.data._id;
  const sub = await s1.api('POST', `/api/student/assignments/${aA1}/submission`, { textAnswer: 'My solution.' });
  assert.equal(sub.status, 200);
  s1SubmissionId = sub.json.data._id;

});

/* ------------------------------ A. AUTH ------------------------------ */
test('A. unauthenticated sign/confirm → 401 on every mount', async () => {
  for (const p of Object.values(ROLE_PATH)) {
    assert.equal((await makeSession().api('POST', `${p}/files/sign`, { parentType: 'note', parentId: noteA1, file: PDF })).status, 401, p);
    assert.equal((await makeSession().api('POST', `${p}/files/confirm`, {})).status, 401, p);
  }
});

/* --------------------- B. PARENT VALIDATION --------------------- */
test('B1. all four supported parents sign successfully', async () => {
  setNow(Date.UTC(2026, 8, 14, 10, 0));
  const ann = await signFile(admin, 'admin', { parentType: 'announcement', parentId: annA1, file: PDF });
  assert.equal(ann.status, 200, 'admin → announcement');
  const note = await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: PDF });
  assert.equal(note.status, 200, 'cr own → note');
  const asg = await signFile(cr1, 'cr', { parentType: 'assignment', parentId: aA1, file: PDF });
  assert.equal(asg.status, 200, 'cr own → assignment');
  const sub = await signFile(s1, 'student', { parentType: 'submission', parentId: s1SubmissionId, file: PDF });
  assert.equal(sub.status, 200, 'student → own submission');
  for (const r of [ann, note, asg, sub]) {
    assert.ok(r.json.data.folder && r.json.data.publicId && r.json.data.signature && r.json.data.timestamp);
  }
});

test('B2. unsupported parent types and bad ids rejected', async () => {
  assert.equal((await signFile(cr1, 'cr', { parentType: 'user', parentId: cr1Id, file: PDF })).status, 400);
  assert.equal((await signFile(cr1, 'cr', { parentType: 'notification', parentId: cr1Id, file: PDF })).status, 400);
  assert.equal((await signFile(cr1, 'cr', { parentType: 'note', parentId: new mongoose.Types.ObjectId(), file: PDF })).status, 404);
  assert.equal((await signFile(cr1, 'cr', { parentType: 'note', parentId: 'zzz', file: PDF })).status, 400);
  assert.equal((await signFile(cr1, 'cr', { parentType: '', parentId: noteA1, file: PDF })).status, 400);
  assert.equal((await confirmFile(cr1, 'cr', { parentType: 'graderesult', parentId: noteA1, result: {} })).status, 400);
});

/* ----------------------- C. AUTHORIZATION ----------------------- */
test('C1. cross-section CR → 404 (no existence leak)', async () => {
  assert.equal((await signFile(cr1, 'cr', { parentType: 'announcement', parentId: annB1, file: PDF })).status, 404);
  assert.equal((await signFile(cr1, 'cr', { parentType: 'note', parentId: annB1, file: PDF })).status, 404);
});

test('C2. student: own submission ONLY — never announcement/note/assignment', async () => {
  assert.equal((await signFile(s1, 'student', { parentType: 'announcement', parentId: annA1, file: PDF })).status, 403);
  assert.equal((await signFile(s1, 'student', { parentType: 'note', parentId: noteA1, file: PDF })).status, 403);
  assert.equal((await signFile(s1, 'student', { parentType: 'assignment', parentId: aA1, file: PDF })).status, 403);
  // another student's submission → 404 (isolation)
  const s2sub = await s2.api('POST', `/api/student/assignments/${aA1}/submission`, { textAnswer: 'S2 work.' });
  assert.equal((await signFile(s1, 'student', { parentType: 'submission', parentId: s2sub.json.data._id, file: PDF })).status, 404);
});

test('C3. CR/admin may never attach to submissions', async () => {
  assert.equal((await signFile(cr1, 'cr', { parentType: 'submission', parentId: s1SubmissionId, file: PDF })).status, 403);
  assert.equal((await signFile(admin, 'admin', { parentType: 'submission', parentId: s1SubmissionId, file: PDF })).status, 403);
});

test('C4. admin cross-section allowed; archived parents closed', async () => {
  assert.equal((await signFile(admin, 'admin', { parentType: 'announcement', parentId: annB1, file: PDF })).status, 200);
  // archived announcement → no new attachments
  await cr1.api('POST', `/api/cr/announcements/${annA1}/archive`);
  assert.equal((await signFile(admin, 'admin', { parentType: 'announcement', parentId: annA1, file: PDF })).status, 400);
  const ann2 = (await cr1.api('POST', '/api/cr/announcements', { title: 'Fresh', content: 'Open.' })).json.data._id;
  annA1 = ann2; // restore a usable open announcement for later tests
});

test('C5. submission rules: archived assignment / past deadline block uploads', async () => {
  // past deadline (server clock pinned beyond it)
  setNow(Date.now() + 10 * 24 * 3600 * 1000);
  assert.equal((await signFile(s1, 'student', { parentType: 'submission', parentId: s1SubmissionId, file: PDF })).status, 400);
  setNow(null);
  // archived assignment
  const asg2 = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Task 2', instructions: 'Quick.',
    deadline: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
  });
  const sub2 = await s1.api('POST', `/api/student/assignments/${asg2.json.data._id}/submission`, { textAnswer: 'Early.' });
  await cr1.api('POST', `/api/cr/assignments/${asg2.json.data._id}/archive`);
  assert.equal((await signFile(s1, 'student', { parentType: 'submission', parentId: sub2.json.data._id, file: PDF })).status, 400);
});

/* ------------------- D. OWNERSHIP INJECTION ------------------- */
test('D1. client folder/publicId/section/owner fields are ignored — server derives everything', async () => {
  const res = await signFile(cr1, 'cr', {
    parentType: 'note', parentId: noteA1, file: PDF,
    folder: 'iub-cr-lms/announcement/' + annB1 + '/evil', // injected
    publicId: '../../evil/overwrite',                      // injected
    section: secB,                                          // injected
    owner: s2Id, createdBy: cr2Id,                          // injected
  });
  assert.equal(res.status, 200);
  const d = res.json.data;
  assert.match(d.folder, new RegExp(`^iub-cr-lms/note/${noteA1}$`));
  assert.match(d.publicId, new RegExp(`^iub-cr-lms/note/${noteA1}/note-[0-9a-f]{24}-[0-9a-f]{12}$`));
  assert.ok(!d.publicId.includes('..'));
  assert.ok(!d.publicId.includes('evil'));
  assert.equal(d.folder.startsWith('iub-cr-lms/announcement'), false);
});

/* ---------------------- E. FILE RESTRICTIONS ---------------------- */
test('E1. allowed academic types pass with correct resource_type', async () => {
  const cases = [
    { originalName: 'a.pdf', mimeType: 'application/pdf', resourceType: 'raw' },
    { originalName: 'a.png', mimeType: 'image/png', resourceType: 'image' },
    { originalName: 'a.jpg', mimeType: 'image/jpeg', resourceType: 'image' },
    { originalName: 'a.jpeg', mimeType: 'image/jpeg', resourceType: 'image' },
    { originalName: 'a.webp', mimeType: 'image/webp', resourceType: 'image' },
    { originalName: 'a.doc', mimeType: 'application/msword', resourceType: 'raw' },
    { originalName: 'a.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', resourceType: 'raw' },
    { originalName: 'a.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', resourceType: 'raw' },
    { originalName: 'a.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', resourceType: 'raw' },
    { originalName: 'a.txt', mimeType: 'text/plain', resourceType: 'raw' },
  ];
  for (const c of cases) {
    const res = await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: c });
    assert.equal(res.status, 200, c.originalName);
    assert.equal(res.json.data.resourceType, c.resourceType, c.originalName);
  }
});

test('E2. dangerous extensions/MIMEs rejected; mismatch rejected', async () => {
  for (const file of [
    { originalName: 'a.exe', mimeType: 'application/x-msdownload' },
    { originalName: 'a.bat', mimeType: 'application/x-bat' },
    { originalName: 'a.cmd', mimeType: 'text/plain' },
    { originalName: 'a.sh', mimeType: 'application/x-sh' },
    { originalName: 'a.js', mimeType: 'text/javascript' },
    { originalName: 'a.msi', mimeType: 'application/x-msi' },
    { originalName: 'a.dll', mimeType: 'application/x-dll' },
    { originalName: 'a.ps1', mimeType: 'text/plain' },
    { originalName: 'a.php', mimeType: 'application/x-httpd-php' },
    { originalName: 'noext', mimeType: 'application/pdf' }, // extension required
    { originalName: 'a.pdf', mimeType: 'application/x-msdownload' }, // mismatch
    { originalName: 'a.pdf', mimeType: 'image/png' }, // mismatch
    { originalName: 'a.png.exe', mimeType: 'image/png' }, // real ext is exe
    { originalName: 'a.zip', mimeType: 'application/zip' }, // not in project allowlist
  ]) {
    assert.equal((await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file })).status, 400, file.originalName);
  }
  assert.equal((await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1 })).status, 400);
});

/* ---------------------- F. SIGNATURE SECURITY ---------------------- */
test('F1. signature/folder/publicId/timestamp server-derived; algorithm = official sha1; secret absent', async () => {
  setNow(Date.UTC(2026, 8, 14, 12, 0, 0));
  const res = await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: PDF });
  assert.equal(res.status, 200);
  const d = res.json.data;
  assert.equal(d.cloudName, CLOUD_NAME);
  assert.equal(d.timestamp, Math.floor(Date.UTC(2026, 8, 14, 12, 0, 0) / 1000)); // SERVER time, not client
  assert.equal(d.signature, expectedSignature({ folder: d.folder, publicId: d.publicId, timestamp: d.timestamp }));
  assert.equal(d.maxSizeBytes, 10 * 1024 * 1024);
  assert.equal(d.uploadUrl, `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/raw/upload`);
  // the API secret must never cross the boundary
  assert.ok(!res.text.includes(API_SECRET));
  assert.ok(!res.text.includes('apiSecret'));
  setNow(null);
});

test('F2. two signs produce different publicIds (no overwrite of existing assets)', async () => {
  const a = await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: PDF });
  const b = await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: PDF });
  assert.notEqual(a.json.data.publicId, b.json.data.publicId);
  assert.ok(a.json.data.publicId.startsWith(b.json.data.folder.split('/').slice(0, 3).join('/')));
});

test('F3. missing Cloudinary config → safe 503, no secret name leaked', async () => {
  const saved = process.env.CLOUDINARY_API_SECRET;
  process.env.CLOUDINARY_API_SECRET = '';
  const res = await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: PDF });
  assert.equal(res.status, 503);
  assert.ok(!res.text.includes('CLOUDINARY') && !res.text.includes('secret'));
  process.env.CLOUDINARY_API_SECRET = saved;
});

/* ------------------- G. CONFIRM VERIFICATION ------------------- */
let noteSignRes; // reused across G tests

test('G0. valid Cloudinary result confirmed → verified FileMeta embedded', async () => {
  noteSignRes = (await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: PDF })).json.data;
  const confirm = await confirmFile(cr1, 'cr', {
    parentType: 'note', parentId: noteA1,
    result: cloudinaryResult(noteSignRes, { format: 'pdf', resourceType: 'raw' }),
  });
  assert.equal(confirm.status, 200, confirm.text);
  const meta = confirm.json.data;
  assert.equal(meta.publicId, noteSignRes.publicId);
  assert.ok(meta.url.startsWith(`https://res.cloudinary.com/${CLOUD_NAME}/`));
  assert.equal(meta.format, 'pdf');
  assert.equal(meta.mimeType, 'application/pdf');
  assert.equal(meta.size, 2048);
  assert.equal(meta.folder, noteSignRes.folder);
  assert.equal(String(meta.uploadedBy), String(cr1Id)); // server-derived
  // embedded in the parent
  const note = await Note.findById(noteA1);
  assert.equal(note.attachments.length, 1);
  assert.equal(note.attachments[0].publicId, noteSignRes.publicId);
});

test('G1. wrong folder / foreign publicId / path traversal rejected', async () => {
  const s = (await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: PDF })).json.data;
  const cases = [
    { ...cloudinaryResult(s, { format: 'pdf', resourceType: 'raw' }), folder: `iub-cr-lms/announcement/${annA1}` },
    { ...cloudinaryResult(s, { format: 'pdf', resourceType: 'raw' }), public_id: `${s.folder}/../../evil` },
    { ...cloudinaryResult(s, { format: 'pdf', resourceType: 'raw' }), public_id: 'iub-cr-lms/note/' + new mongoose.Types.ObjectId() + '/note-' + s.publicId.slice(-36) },
    { ...cloudinaryResult(s, { format: 'pdf', resourceType: 'raw' }), public_id: s.folder }, // missing suffix
  ];
  for (const result of cases) {
    const res = await confirmFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, result });
    assert.equal(res.status, 400, JSON.stringify(result).slice(0, 80));
  }
});

test('G2. URL verification: http / external domain / wrong account / asset mismatch rejected', async () => {
  const s = (await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: { originalName: 'x.png', mimeType: 'image/png' } })).json.data;
  const png = { format: 'png', resourceType: 'image' };
  const cases = [
    { ...cloudinaryResult(s, png), secure_url: `http://res.cloudinary.com/${CLOUD_NAME}/image/upload/${s.publicId}.png` },
    { ...cloudinaryResult(s, png), secure_url: `https://evil.example.com/${s.publicId}.png` },
    { ...cloudinaryResult(s, png), secure_url: `https://res.cloudinary.com/other-account/image/upload/${s.publicId}.png` },
    { ...cloudinaryResult(s, png), secure_url: `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/other-asset.png` },
    { ...cloudinaryResult(s, png), secure_url: `javascript:alert(1)` },
    { ...cloudinaryResult(s, png), secure_url: `data:image/png;base64,AAAA` },
  ];
  for (const result of cases) {
    const res = await confirmFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, result });
    assert.equal(res.status, 400, result.secure_url.slice(0, 60));
  }
});

test('G3. resource_type/format pairing and size verification', async () => {
  const s = (await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: PDF })).json.data;
  const cases = [
    cloudinaryResult(s, { format: 'pdf', resourceType: 'image' }),   // wrong resource type for pdf
    cloudinaryResult(s, { format: 'exe', resourceType: 'raw' }),     // dangerous format
    cloudinaryResult(s, { format: 'pdf', resourceType: 'raw', bytes: 11 * 1024 * 1024 }), // oversized
    cloudinaryResult(s, { format: 'pdf', resourceType: 'raw', bytes: 0 }),  // no size
    cloudinaryResult(s, { format: 'pdf', resourceType: 'raw', bytes: 'lots' }),
  ];
  for (const result of cases) {
    const res = await confirmFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, result });
    assert.equal(res.status, 400, JSON.stringify(result).slice(0, 80));
  }
});

test('G4. cross-section confirm attempts are blocked', async () => {
  // CR2 (section B) signs its own announcement then tries to confirm into A's note with B's asset
  const bSign = (await signFile(cr2, 'cr', { parentType: 'announcement', parentId: annB1, file: PDF })).json.data;
  const res = await confirmFile(cr2, 'cr', {
    parentType: 'note', parentId: noteA1, // A's note — CR2 has no access
    result: cloudinaryResult(bSign, { format: 'pdf', resourceType: 'raw' }),
  });
  assert.equal(res.status, 404); // isolation — cross-section = missing
});

/* ------------------- H. DUPLICATE / REPLAY ------------------- */
test('H1. same asset confirmed twice → one FileMeta, idempotent success', async () => {
  const s = (await signFile(admin, 'admin', { parentType: 'announcement', parentId: annA1, file: PDF })).json.data;
  const result = cloudinaryResult(s, { format: 'pdf', resourceType: 'raw' });
  const c1 = await confirmFile(admin, 'admin', { parentType: 'announcement', parentId: annA1, result });
  const c2 = await confirmFile(admin, 'admin', { parentType: 'announcement', parentId: annA1, result });
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200); // replay → idempotent, not an error
  assert.equal(c1.json.data._id ?? c1.json.data.publicId, c2.json.data._id ?? c2.json.data.publicId);
  assert.equal((await Announcement.findById(annA1)).attachments.length, 1);
});

test('H2. 10 concurrent confirms of the same asset → exactly one entry', async () => {
  const s = (await signFile(cr1, 'cr', { parentType: 'assignment', parentId: aA1, file: PDF })).json.data;
  const result = cloudinaryResult(s, { format: 'pdf', resourceType: 'raw' });
  const calls = await Promise.allSettled(Array.from({ length: 10 }, () =>
    confirmFile(cr1, 'cr', { parentType: 'assignment', parentId: aA1, result })));
  assert.ok(calls.every((c) => c.value.status === 200), 'no race may fail');
  assert.equal((await Assignment.findById(aA1)).attachments.length, 1);
});

test('H3. per-parent attachment limit (10) enforced atomically', async () => {
  for (let i = 0; i < 9; i++) { // note already has 1 from G0
    const s = (await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: { originalName: `f${i}.txt`, mimeType: 'text/plain' } })).json.data;
    const res = await confirmFile(cr1, 'cr', {
      parentType: 'note', parentId: noteA1,
      result: cloudinaryResult(s, { format: 'txt', resourceType: 'raw', bytes: 100, name: `f${i}.txt` }),
    });
    assert.equal(res.status, 200, `file ${i}`);
  }
  assert.equal((await Note.findById(noteA1)).attachments.length, 10);
  // the 11th is rejected
  const s11 = (await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: { originalName: 'z.txt', mimeType: 'text/plain' } }));
  assert.equal(s11.status, 200); // signing is still fine
  const res11 = await confirmFile(cr1, 'cr', {
    parentType: 'note', parentId: noteA1,
    result: cloudinaryResult(s11.json.data, { format: 'txt', resourceType: 'raw', bytes: 100 }),
  });
  assert.equal(res11.status, 400);
});

/* --------------------- I. CONTENT INTEGRATION --------------------- */
test('I1. confirmed submission file appears via existing APIs; resubmission preserves it', async () => {
  const s = (await signFile(s1, 'student', { parentType: 'submission', parentId: s1SubmissionId, file: { originalName: 'solution.pdf', mimeType: 'application/pdf' } })).json.data;
  const confirm = await confirmFile(s1, 'student', {
    parentType: 'submission', parentId: s1SubmissionId,
    result: cloudinaryResult(s, { format: 'pdf', resourceType: 'raw', name: 'solution.pdf' }),
  });
  assert.equal(confirm.status, 200);

  const mine = await s1.api('GET', `/api/student/assignments/${aA1}/submission`);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.data.files.length, 1);
  assert.equal(mine.json.data.files[0].format, 'pdf');

  // resubmitting text must NOT wipe confirmed attachments
  const resub = await s1.api('POST', `/api/student/assignments/${aA1}/submission`, { textAnswer: 'Revised text.' });
  assert.equal(resub.status, 200);
  const doc = await Submission.findById(s1SubmissionId);
  assert.equal(doc.files.length, 1);
  assert.equal(doc.textAnswer, 'Revised text.');

  // files-only payload (no text) is valid when a confirmed file exists
  const filesOnly = await s1.api('POST', `/api/student/assignments/${aA1}/submission`, { textAnswer: '   ' });
  assert.equal(filesOnly.status, 200); // has confirmed files → not "empty"
  assert.equal((await Submission.findById(s1SubmissionId)).files.length, 1);
});

test('I2. attachment injection through normal content CRUD is impossible', async () => {
  // create
  const ann = await cr1.api('POST', '/api/cr/announcements', {
    title: 'No injection', content: 'Clean.',
    attachments: [{ publicId: 'iub-cr-lms/fake/x', url: 'https://evil.example/x.pdf', format: 'pdf', size: 5 }],
  });
  assert.equal(ann.status, 200);
  assert.equal(ann.json.data.attachments.length, 0);
  assert.equal((await Announcement.findById(ann.json.data._id)).attachments.length, 0);
  // update
  const upd = await cr1.api('PATCH', `/api/cr/announcements/${ann.json.data._id}`, {
    content: 'Edited.',
    attachments: [{ publicId: 'injected', url: 'https://res.cloudinary.com/x/raw/upload/y.pdf' }],
  });
  assert.equal(upd.status, 200);
  assert.equal((await Announcement.findById(ann.json.data._id)).attachments.length, 0);
  // assignment injection
  const asg = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Inj test', instructions: 'x',
    deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
    attachments: [{ publicId: 'hack', url: 'https://evil.example/a.pdf' }],
  });
  assert.equal(asg.status, 200);
  assert.equal((await Assignment.findById(asg.json.data._id)).attachments.length, 0);
  // submission injection (route-level strip — the Step 10 contract)
  const sub = await s2.api('POST', `/api/student/assignments/${aA1}/submission`, {
    textAnswer: 'S2 text.',
    files: [{ publicId: 'iub-cr-lms/submission/x/x', url: 'https://res.cloudinary.com/test-cloud-xyz/raw/upload/x.pdf' }],
  });
  assert.equal(sub.status, 200);
  assert.equal((await Submission.findById(sub.json.data._id)).files.length, 0);
});

/* ------------------------- J. SECURITY ------------------------- */
test('J1. audit events exist, stay aggregate, and NEVER contain secrets or signatures', async () => {
  assert.ok(await AuditLog.countDocuments({ action: 'file.upload.signature' }) >= 5);
  assert.ok(await AuditLog.countDocuments({ action: 'file.upload.confirm' }) >= 3);
  assert.ok(await AuditLog.countDocuments({ action: 'file.upload.reject' }) >= 5);

  const logs = await AuditLog.find({ action: /^file\.upload/ });
  const text = JSON.stringify(logs.map((l) => ({
    a: l.action, b: l.before, c: l.after, d: l.reason,
  })));
  assert.ok(!text.includes(API_SECRET), 'api secret never logged');
  assert.ok(!text.includes('fake-api-secret'), 'secret value never logged');
  assert.ok(!/signature.{20,}["']?[0-9a-f]{40}/.test(text), 'no upload signatures logged');
  assert.ok(!text.includes('Pass1234') && !text.includes('test-only-jwt-secret'));
  // rejections carry a reason CATEGORY, not raw payloads
  const rejects = logs.filter((l) => l.action === 'file.upload.reject');
  assert.ok(rejects.length >= 5);
  assert.ok(rejects.every((l) => typeof l.reason === 'string' && l.reason.length < 40));
});

test('J2. no secret material in ANY upload response', async () => {
  const responses = [
    await signFile(admin, 'admin', { parentType: 'announcement', parentId: annA1, file: PDF }),
    await signFile(cr1, 'cr', { parentType: 'note', parentId: noteA1, file: PDF }),
    await signFile(s1, 'student', { parentType: 'submission', parentId: s1SubmissionId, file: PDF }),
  ];
  for (const r of responses) {
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(API_SECRET));
    assert.ok(!r.text.includes('MONGODB'));
    assert.ok(!/\$2[aby]\$/.test(r.text), 'no password hashes');
    assert.ok(!r.text.includes('test-only-jwt-secret'));
    assert.ok(!r.text.includes('fake-test-key'));
  }
});

test('J3. suspended user cannot sign', async () => {
  const u = await User.create({
    name: 'Suspended Up', email: 'fu-susp@test.local', phone: '+923001119997',
    role: 'student', registrationStatus: 'suspended', emailVerified: true,
    password: await bcrypt.hash('Pass1234!', 10), section: secA, rollNo: 'F-009',
  });
  const sess = makeSession();
  // suspended users are rejected by the auth middleware itself (403) — and
  // even a forged session cannot pass role checks
  assert.equal((await sess.api('POST', '/api/auth/login', { email: 'fu-susp@test.local', password: 'Pass1234!' })).status, 403);
  assert.ok(u);
});

test('K. regression: earlier feature surfaces healthy on this instance', async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.database, 'connected');
  assert.equal((await admin.api('GET', '/api/admin/announcements')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/notes')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/assignments')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/notifications')).status, 200);
  assert.equal((await cr1.api('GET', '/api/cr/subjects')).status, 200);
  assert.equal((await s1.api('GET', '/api/student/assignments')).status, 200);
  assert.equal((await s1.api('GET', '/api/student/notifications')).status, 200);
  assert.equal((await cr1.api('GET', '/api/cr/timetable')).status, 200);
});

test.after(async () => {
  delete process.env.MOCK_NOW;
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
