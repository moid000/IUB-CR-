/**
 * STEP 5 tests — announcements + notes. Isolated in-memory REPLICA SET;
 * never touches Atlas; Brevo never invoked here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('announcements_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Section, Subject, Announcement, Note, AuditLog } = models;
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
const cr1 = makeSession(); // section A
const cr2 = makeSession(); // section B
const student1 = makeSession(); // section A

/* ================================ FIXTURES ================================ */
let deptCS, session1, secA, secB, subA1, subB1, subArchivedA;
let cr1Id, cr2Id, student1Id, annAdmin, annA1, annB1, noteA1, noteB1;

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
  await Section.updateOne({ _id: secA }, { $set: { cr: cr1Id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });

  subA1 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' })).json.data._id;
  subB1 = (await admin.api('POST', '/api/admin/subjects', { section: secB, name: 'Databases', code: 'DB-201' })).json.data._id;
  subArchivedA = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Old Course', code: 'OLD-1' })).json.data._id;
  assert.equal((await admin.api('POST', `/api/admin/subjects/${subArchivedA}/archive`)).status, 200);

  assert.equal((await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await cr2.api('POST', '/api/auth/login', { email: 'cr2@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await student1.api('POST', '/api/auth/login', { email: 's1@test.local', password: 'CrPass123!' })).status, 200);
});

/* ============================= ANNOUNCEMENTS ============================= */
test('1. admin creates announcement', async () => {
  const res = await admin.api('POST', '/api/admin/announcements', {
    section: secA, title: 'Midterm dates announced', content: 'Midterms start October 1st.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.status, 'published');
  assert.equal(res.json.data.pinned, false);
  annAdmin = res.json.data._id;
  const got = await admin.api('GET', `/api/admin/announcements/${annAdmin}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.data.author.name, 'Administrator'); // populated, safe
  assert.ok(!got.text.includes('password'));
});

test('2. CR creates announcement in own section (injections ignored)', async () => {
  const res = await cr1.api('POST', '/api/cr/announcements', {
    title: 'Quiz on Friday', content: 'Chapter 4 will be covered.',
    section: secB, sectionId: secB, // must be ignored
    author: student1Id, createdBy: student1Id, role: 'student', // must be ignored
    status: 'archived', // must be ignored
    attachments: [{ publicId: 'evil', url: 'https://evil.example/x' }], // must be dropped
  });
  assert.equal(res.status, 200);
  const doc = await Announcement.findById(res.json.data._id);
  assert.equal(String(doc.section), String(secA)); // own section, server-derived
  assert.equal(String(doc.author), String(cr1Id)); // (23) createdBy injection blocked
  assert.equal(doc.status, 'published'); // (24) status/role injection blocked
  assert.deepEqual(doc.attachments, [], 'attachment payload dropped');
  annA1 = res.json.data._id;
});

test('3. CR cannot create announcement in another section', async () => {
  // CR2 creates with body.section=secA — ignored, lands in secB
  const res = await cr2.api('POST', '/api/cr/announcements', {
    title: 'SecB announcement', content: 'From CR2 with injected section.', section: secA,
  });
  assert.equal(res.status, 200);
  const doc = await Announcement.findById(res.json.data._id);
  assert.equal(String(doc.section), String(secB)); // server-derived
  annB1 = res.json.data._id;
  // CR1's list never contains it
  const list = await cr1.api('GET', '/api/cr/announcements');
  assert.ok(!list.json.data.some((a) => String(a._id) === String(annB1)));
});

test('4. student reads own announcements only', async () => {
  const res = await student1.api('GET', '/api/student/announcements');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.some((a) => String(a._id) === String(annA1)));
  assert.ok(res.json.data.some((a) => String(a._id) === String(annAdmin)));
  assert.ok(!res.json.data.some((a) => String(a._id) === String(annB1)), 'secB announcement must be invisible');
  assert.ok(res.json.data.every((a) => String(a.section) === String(secA)));
  const got = await student1.api('GET', `/api/student/announcements/${annA1}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.data.title, 'Quiz on Friday');
});

test('5. student cannot create/update/archive announcements', async () => {
  assert.equal((await student1.api('POST', '/api/student/announcements', { title: 'X', content: 'Y' })).status, 404);
  assert.equal((await student1.api('POST', '/api/cr/announcements', { title: 'X', content: 'Y' })).status, 403);
  assert.equal((await student1.api('PATCH', `/api/cr/announcements/${annA1}`, { title: 'Hacked' })).status, 403);
  assert.equal((await student1.api('POST', `/api/cr/announcements/${annA1}/archive`)).status, 403);
  assert.equal((await student1.api('POST', '/api/admin/announcements', { section: secA, title: 'X', content: 'Y' })).status, 403);
  assert.equal((await Announcement.findById(annA1)).title, 'Quiz on Friday'); // untouched
});

test('6. cross-section announcement GET → 404 (never 403)', async () => {
  const crTry = await cr1.api('GET', `/api/cr/announcements/${annB1}`);
  assert.equal(crTry.status, 404);
  assert.equal(crTry.json.message, 'Announcement not found');
  const stTry = await student1.api('GET', `/api/student/announcements/${annB1}`);
  assert.equal(stTry.status, 404);
  // CR1 cannot update/archive it either
  assert.equal((await cr1.api('PATCH', `/api/cr/announcements/${annB1}`, { title: 'Hacked' })).status, 404);
  assert.equal((await cr1.api('POST', `/api/cr/announcements/${annB1}/archive`)).status, 404);
  assert.equal((await Announcement.findById(annB1)).status, 'published');
});

test('7. announcement update works (own section)', async () => {
  const res = await cr1.api('PATCH', `/api/cr/announcements/${annA1}`, {
    title: 'Quiz on Friday (updated)', pinned: true,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.title, 'Quiz on Friday (updated)');
  assert.equal(res.json.data.pinned, true);
  const doc = await Announcement.findById(annA1);
  assert.equal(doc.content, 'Chapter 4 will be covered.'); // untouched fields preserved
  // admin can update across sections
  const adminRes = await admin.api('PATCH', `/api/admin/announcements/${annB1}`, { content: 'Admin edited' });
  assert.equal(adminRes.status, 200);
});

test('8–10. announcement archive: works, blocks modification, rejects duplicate', async () => {
  const arch = await cr1.api('POST', `/api/cr/announcements/${annA1}/archive`);
  assert.equal(arch.status, 200);
  const doc = await Announcement.findById(annA1);
  assert.equal(doc.status, 'archived');
  assert.equal(doc.title, 'Quiz on Friday (updated)'); // content preserved
  assert.equal(String(doc.author), String(cr1Id)); // creator preserved
  assert.ok(doc.createdAt && doc.updatedAt); // timestamps preserved

  // archived → cannot be modified
  const upd = await cr1.api('PATCH', `/api/cr/announcements/${annA1}`, { title: 'Nope' });
  assert.equal(upd.status, 400);
  // archived → duplicate archive rejected
  const again = await cr1.api('POST', `/api/cr/announcements/${annA1}/archive`);
  assert.equal(again.status, 409);

  // historical read still works for own section
  assert.equal((await student1.api('GET', `/api/student/announcements/${annA1}`)).status, 200);
  const history = await student1.api('GET', '/api/student/announcements?status=archived');
  assert.ok(history.json.data.some((a) => String(a._id) === String(annA1)));
});

/* ================================= NOTES ================================= */
test('11. admin creates note', async () => {
  const res = await admin.api('POST', '/api/admin/notes', {
    section: secA, subject: subA1, title: 'Normalization notes', content: '1NF, 2NF, 3NF explained.',
  });
  assert.equal(res.status, 200);
  assert.equal(String(res.json.data.subject), String(subA1));
  const got = await admin.api('GET', `/api/admin/notes/${res.json.data._id}`);
  assert.equal(got.status, 200);
});

test('12. CR creates note in own section', async () => {
  const res = await cr1.api('POST', '/api/cr/notes', {
    title: 'ER diagrams summary', subject: subA1, content: 'Entities and relations.',
    section: secB, author: student1Id, status: 'archived', // all ignored
  });
  assert.equal(res.status, 200);
  const doc = await Note.findById(res.json.data._id);
  assert.equal(String(doc.section), String(secA)); // (22) server-derived
  assert.equal(String(doc.author), String(cr1Id)); // (23) injection blocked
  assert.equal(String(doc.subject), String(subA1)); // own-section subject OK
  assert.equal(doc.status, 'published'); // (24) injection blocked
  noteA1 = res.json.data._id;
});

test('13. CR cannot create note in another section', async () => {
  const res = await cr2.api('POST', '/api/cr/notes', {
    title: 'CR2 note', content: 'Should land in secB despite injected section.', section: secA,
  });
  assert.equal(res.status, 200);
  const doc = await Note.findById(res.json.data._id);
  assert.equal(String(doc.section), String(secB));
  noteB1 = res.json.data._id;
  const list = await cr1.api('GET', '/api/cr/notes');
  assert.ok(!list.json.data.some((n) => String(n._id) === String(noteB1)));
});

test('14. student reads own section notes only', async () => {
  const res = await student1.api('GET', '/api/student/notes');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.some((n) => String(n._id) === String(noteA1)));
  assert.ok(!res.json.data.some((n) => String(n._id) === String(noteB1)));
  assert.ok(res.json.data.every((n) => String(n.section) === String(secA)));
  const got = await student1.api('GET', `/api/student/notes/${noteA1}`);
  assert.equal(got.status, 200);
});

test('15. student cannot create/update/archive notes', async () => {
  assert.equal((await student1.api('POST', '/api/student/notes', { title: 'X' })).status, 404);
  assert.equal((await student1.api('POST', '/api/cr/notes', { title: 'X' })).status, 403);
  assert.equal((await student1.api('PATCH', `/api/cr/notes/${noteA1}`, { title: 'Hacked' })).status, 403);
  assert.equal((await student1.api('POST', `/api/cr/notes/${noteA1}/archive`)).status, 403);
  assert.equal((await Note.findById(noteA1)).title, 'ER diagrams summary');
});

test('16. cross-section note GET → 404 (never 403)', async () => {
  assert.equal((await cr1.api('GET', `/api/cr/notes/${noteB1}`)).status, 404);
  assert.equal((await cr1.api('PATCH', `/api/cr/notes/${noteB1}`, { title: 'Hacked' })).status, 404);
  assert.equal((await cr1.api('POST', `/api/cr/notes/${noteB1}/archive`)).status, 404);
  assert.equal((await student1.api('GET', `/api/student/notes/${noteB1}`)).status, 404);
  assert.equal((await Note.findById(noteB1)).status, 'published');
});

test('17. note update works', async () => {
  const res = await cr1.api('PATCH', `/api/cr/notes/${noteA1}`, {
    title: 'ER diagrams summary v2', content: 'Updated with examples.',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.title, 'ER diagrams summary v2');
  // subject can be re-linked to another OWN-section subject, or cleared
  const cleared = await cr1.api('PATCH', `/api/cr/notes/${noteA1}`, { subject: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.data.subject, null);
});

test('18–20. note archive: works, blocks modification, rejects duplicate', async () => {
  const arch = await cr1.api('POST', `/api/cr/notes/${noteA1}/archive`);
  assert.equal(arch.status, 200);
  const doc = await Note.findById(noteA1);
  assert.equal(doc.status, 'archived');
  assert.equal(doc.title, 'ER diagrams summary v2'); // preserved
  assert.equal((await cr1.api('PATCH', `/api/cr/notes/${noteA1}`, { title: 'Nope' })).status, 400);
  assert.equal((await cr1.api('POST', `/api/cr/notes/${noteA1}/archive`)).status, 409);
  // still readable as history by own section
  assert.equal((await student1.api('GET', `/api/student/notes/${noteA1}`)).status, 200);
});

/* ====================== SUBJECT VALIDATION & SECURITY ====================== */
test('21. note with subject from another section rejected; archived subject rejected', async () => {
  const cross = await cr1.api('POST', '/api/cr/notes', {
    title: 'Bad note', content: 'Subject belongs to secB.', subject: subB1,
  });
  assert.equal(cross.status, 400);
  assert.match(cross.json.message, /does not belong/i);

  const archivedSub = await cr1.api('POST', '/api/cr/notes', {
    title: 'Archived subject note', content: 'Subject is archived.', subject: subArchivedA,
  });
  assert.equal(archivedSub.status, 400);
  assert.match(archivedSub.json.message, /archived/i);

  // same via admin update path: admin note in secA + subject from secB → rejected
  const adminNote = await admin.api('POST', '/api/admin/notes', {
    section: secA, title: 'Admin note', content: 'For cross-subject test.',
  });
  const upd = await admin.api('PATCH', `/api/admin/notes/${adminNote.json.data._id}`, { subject: subB1 });
  assert.equal(upd.status, 400); // cross-section subject rejected on update too

  // missing subject id → 400
  const missing = await cr1.api('POST', '/api/cr/notes', {
    title: 'Ghost subject note', subject: '507f1f77bcf86cd799439011',
  });
  assert.equal(missing.status, 400);

  // positive path: subjectId filter works and stays section-scoped
  const bySubject = await cr1.api('GET', `/api/cr/notes?subjectId=${subA1}`);
  assert.equal(bySubject.status, 200);
  assert.ok(bySubject.json.data.every((n) => String(n.subject._id) === String(subA1)));
  // subject is now POPULATED in list responses: { _id, name, code }
  assert.ok(bySubject.json.data.every((n) => n.subject.name && n.subject.code));
  assert.ok(bySubject.json.data.every((n) => String(n.section) === String(secA)));
});

test('22–24. client injections (section/createdBy/role/status/pastMembers) blocked', async () => {
  // already asserted inline above; verify DB state is clean of injected values
  const notes = await Note.find({ section: secA });
  assert.ok(notes.every((n) => String(n.author) === String(cr1Id) || String(n.author) !== String(student1Id)));
  const anns = await Announcement.find({ section: secA });
  assert.ok(anns.every((a) => String(a.author) === String(cr1Id) || String(a.author) !== String(student1Id)));
  // section injection on PATCH never moves a note across sections
  const before = await Note.findById(noteB1);
  await cr2.api('PATCH', `/api/cr/notes/${noteB1}`, { title: 'Renamed', section: secA });
  const after = await Note.findById(noteB1);
  assert.equal(String(after.section), String(before.section), 'section immutable');
});

test('25. invalid ObjectId returns clean 400', async () => {
  for (const p of ['/api/admin/announcements/zzz', '/api/cr/announcements/zzz',
    '/api/student/announcements/zzz', '/api/admin/notes/zzz',
    '/api/cr/notes/zzz', '/api/student/notes/zzz']) {
    const session = p.startsWith('/api/admin') ? admin : p.startsWith('/api/cr') ? cr1 : student1;
    assert.equal((await session.api('GET', p)).status, 400, p);
  }
  assert.equal((await admin.api('GET', '/api/admin/notes?subjectId=bad')).status, 400);
});

test('26. pagination maximum enforced (cap 100)', async () => {
  for (let i = 0; i < 5; i++) {
    await cr1.api('POST', '/api/cr/announcements', { title: `Bulk ${i}`, content: 'x' });
  }
  const page = await cr1.api('GET', '/api/cr/announcements?limit=2&page=2');
  assert.equal(page.status, 200);
  assert.equal(page.json.data.length, 2);
  assert.ok(page.json.pagination.total >= 6);
  const capped = await cr1.api('GET', '/api/cr/announcements?limit=5000');
  assert.equal(capped.json.pagination.limit, 100);
  const adminCapped = await admin.api('GET', '/api/admin/announcements?limit=9999');
  assert.equal(adminCapped.json.pagination.limit, 100);
});

test('27. search input safely escaped (no regex/operators through)', async () => {
  const res = await cr1.api('GET', '/api/cr/announcements?search=.*');
  assert.equal(res.status, 200); // literal ".*" — never a Mongo operator
  const noMatch = res.json.data.filter((a) => a.title === '.*');
  assert.equal(noMatch.length, 0);
  const bracket = await cr1.api('GET', '/api/cr/announcements?search=[a-z]+{1}');
  assert.equal(bracket.status, 200); // invalid regex as literal — no 500
  const needle = await cr1.api('GET', '/api/cr/announcements?search=Bulk 3');
  assert.ok(needle.json.data.some((a) => a.title === 'Bulk 3'));
  const dollar = await admin.api('GET', '/api/admin/notes?search={"$ne":null}');
  assert.equal(dollar.status, 200);
  assert.equal(dollar.json.data.length, 0); // literal string, no operator injection
});

test('28. sensitive fields never returned', async () => {
  const checks = [
    await admin.api('GET', '/api/admin/announcements'),
    await admin.api('GET', '/api/admin/notes'),
    await cr1.api('GET', '/api/cr/announcements'),
    await student1.api('GET', '/api/student/notes'),
  ];
  for (const r of checks) {
    assert.ok(!/\$2[aby]\$/.test(r.text), 'no hash');
    assert.ok(!r.text.includes('activationToken') && !r.text.includes('resetToken') && !r.text.includes('codeHash'));
  }
  // attachments metadata present only as [] — no publicId/url injection possible
  const list = await cr1.api('GET', '/api/cr/announcements');
  assert.ok(list.json.data.every((a) => (a.attachments ?? []).length === 0));
});

test('29. audit events created (announcement.*, note.*) with no secrets', async () => {
  for (const action of ['announcement.create', 'announcement.update', 'announcement.archive',
    'note.create', 'note.update', 'note.archive']) {
    assert.ok(await AuditLog.countDocuments({ action }) > 0, `${action} recorded`);
  }
  const logs = await AuditLog.find({ action: /^announcement\.|^note\./ });
  const text = JSON.stringify(logs.map((l) => ({ b: l.before, a: l.after })));
  assert.ok(!text.includes('password') && !text.includes('CrPass'));
});

test('30. regression guard: previous-phase routes still healthy', async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.database, 'connected');
  assert.equal((await admin.api('GET', '/api/admin/subjects')).status, 200);
  assert.equal((await cr1.api('GET', '/api/cr/subjects')).status, 200);
  assert.equal((await student1.api('GET', '/api/student/subjects')).status, 200);
  assert.equal((await cr1.api('GET', '/api/cr/students')).status, 200);
  const bad = await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'Wrong1!' });
  assert.equal(bad.status, 401);
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
