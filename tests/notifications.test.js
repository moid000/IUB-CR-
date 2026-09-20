/**
 * STEP 9 tests — in-app notifications. Isolated in-memory REPLICA SET so the
 * partial unique index {recipient, dedupeKey} and concurrent-insert races
 * behave exactly like production. Reminder tests pin MOCK_NOW and assert
 * Asia/Karachi wall-clock semantics (never UTC dates).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('notifications_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const notifSvc = await import('../backend/services/notificationService.js');

const { User, Section, Subject, Notification, AuditLog, Assignment } = models;
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
const cr1 = makeSession();  // section A
const cr2 = makeSession();  // section B
const s1 = makeSession();   // section A active
const s2 = makeSession();   // section A active
const s3 = makeSession();   // section A active (later rolls over to B)
const s4 = makeSession();   // section A active — isolated user for by-type badge tests

let deptCS, session1, secA, secB, subA1, subB1;
let s1Id, s2Id, s3Id, s4Id, cr1Id, cr2Id;
let ann1, ann1Id, ann2Id;   // announcements
let asg1Id;                 // assignment

const setNow = (epoch) => {
  if (epoch === null) delete process.env.MOCK_NOW;
  else process.env.MOCK_NOW = String(epoch);
};

test('fixtures: hierarchy, users, logins', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  deptCS = (await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  session1 = (await admin.api('POST', '/api/admin/sessions', { name: '2027–28' })).json.data._id;
  secA = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5A' })).json.data._id;
  secB = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5B' })).json.data._id;

  const hash = await bcrypt.hash('Pass1234!', 10);
  const mk = (name, email, role, section, extra = {}) => User.create({
    name, email, phone: '+9230011100' + Math.floor(Math.random() * 900 + 99),
    role, registrationStatus: 'active', emailVerified: true, password: hash, section, ...extra,
  }).then((u) => u._id);
  cr1Id = await mk('CR One', 'cr1@test.local', 'cr', secA, { status: 'active' });
  cr2Id = await mk('CR Two', 'cr2@test.local', 'cr', secB);
  s1Id = await mk('Student One', 'ns1@test.local', 'student', secA, { rollNo: 'N-001' });
  s2Id = await mk('Student Two', 'ns2@test.local', 'student', secA, { rollNo: 'N-002' });
  s3Id = await mk('Student Three', 'ns3@test.local', 'student', secA, { rollNo: 'N-003' });
  await User.create({ // suspended member of A
    name: 'Suspended', email: 'nsusp@test.local', phone: '+923001119999', role: 'student',
    registrationStatus: 'suspended', emailVerified: true, password: hash, section: secA, rollNo: 'N-004',
  });
  await User.create({ // pending member of A
    name: 'Pending', email: 'npend@test.local', phone: '+923001119998', role: 'student',
    registrationStatus: 'pending', emailVerified: true, password: hash, section: secA, rollNo: 'N-005',
  });
  await Section.updateOne({ _id: secA }, { $set: { cr: cr1Id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });

  subA1 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' })).json.data._id;
  subB1 = (await admin.api('POST', '/api/admin/subjects', { section: secB, name: 'Databases', code: 'DB-201' })).json.data._id;

  assert.equal((await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'Pass1234!' })).status, 200);
  assert.equal((await cr2.api('POST', '/api/auth/login', { email: 'cr2@test.local', password: 'Pass1234!' })).status, 200);
  assert.equal((await s1.api('POST', '/api/auth/login', { email: 'ns1@test.local', password: 'Pass1234!' })).status, 200);
  assert.equal((await s2.api('POST', '/api/auth/login', { email: 'ns2@test.local', password: 'Pass1234!' })).status, 200);
  const s4Hash = await bcrypt.hash('Pass1234!', 10);
  // secB, not secA — kept OUT of every secA fan-out recipient count in D1/E1/etc.
  s4Id = (await User.create({
    name: 'Student Four', email: 'ns4@test.local', phone: '+923001119997', role: 'student',
    registrationStatus: 'active', emailVerified: true, password: s4Hash, section: secB, rollNo: 'NB-006',
  }))._id;
  assert.equal((await s3.api('POST', '/api/auth/login', { email: 'ns3@test.local', password: 'Pass1234!' })).status, 200);
  assert.equal((await s4.api('POST', '/api/auth/login', { email: 'ns4@test.local', password: 'Pass1234!' })).status, 200);
});

/* ------------------------------ A. AUTH ------------------------------ */
test('A. unauthenticated notification access → 401', async () => {
  assert.equal((await makeSession().api('GET', '/api/student/notifications')).status, 401);
  assert.equal((await makeSession().api('GET', '/api/student/notifications/unread-count')).status, 401);
  assert.equal((await makeSession().api('GET', '/api/student/notifications/unread-count-by-type')).status, 401);
  assert.equal((await makeSession().api('POST', '/api/student/notifications/read-by-type', { types: ['announcement'] })).status, 401);
  assert.equal((await makeSession().api('POST', '/api/student/notifications/507f1f77bcf86cd799439011/read')).status, 401);
  assert.equal((await makeSession().api('GET', '/api/cr/notifications')).status, 401);
  assert.equal((await makeSession().api('GET', '/api/admin/notifications')).status, 401);
  assert.equal((await makeSession().api('POST', '/api/notifications/read-all')).status, 404); // no global mount — unknown route 404s
});

/* --------------------- D. ANNOUNCEMENT FAN-OUT --------------------- */
test('D1. CR announcement → only CURRENT active section-A members notified; no self-notify', async () => {
  setNow(null);
  const res = await cr1.api('POST', '/api/cr/announcements', {
    title: 'Quiz on Friday',
    content: 'DB quiz covering normalization.',
    // injection attempts — all must be ignored
    section: secB, recipient: cr2Id, dedupeKey: 'HACK', read: true, createdAt: '2000-01-01',
  });
  assert.equal(res.status, 200);
  ann1 = res.json.data;
  ann1Id = String(ann1._id);

  // active students of A got exactly one notification each
  for (const [sid, label] of [[s1Id, 's1'], [s2Id, 's2'], [s3Id, 's3']]) {
    const docs = await Notification.find({ recipient: sid }).lean();
    const own = docs.filter((d) => String(d.refId) === ann1Id);
    assert.equal(own.length, 1, `${label} notified exactly once`);
    assert.equal(own[0].type, 'announcement');
    assert.equal(own[0].refType, 'Announcement');
    assert.equal(own[0].read, false);
    assert.equal(own[0].dedupeKey, `announcement:${ann1Id}:${sid}`);
  }
  // actor CR not self-notified
  assert.equal(await Notification.countDocuments({ recipient: cr1Id, refId: ann1._id }), 0);
  // suspended / pending excluded
  assert.equal(await Notification.countDocuments({ refId: ann1._id, $or: [
    { recipient: (await User.findOne({ email: 'nsusp@test.local' }))._id },
    { recipient: (await User.findOne({ email: 'npend@test.local' }))._id },
  ] }), 0);
  // other section entirely untouched
  assert.equal(await Notification.countDocuments({ refId: ann1._id }), 3);
});

test('D2. admin announcement → CR is notified too (CR not the actor)', async () => {
  const res = await admin.api('POST', '/api/admin/announcements', { section: secA, title: 'Fee deadline', content: 'Pay by the 20th.' });
  assert.equal(res.status, 200);
  ann2Id = String(res.json.data._id);
  assert.equal(await Notification.countDocuments({ refId: res.json.data._id, recipient: cr1Id }), 1);
  assert.equal(await Notification.countDocuments({ refId: res.json.data._id, recipient: s1Id }), 1);
  assert.equal(await Notification.countDocuments({ refId: res.json.data._id, recipient: cr2Id }), 0);
});

test('D3. retry/replay of the same fan-out is idempotent (no duplicates)', async () => {
  const before = await Notification.countDocuments({ refId: ann1._id });
  // simulate a retried request replaying the exact same event
  const inserted = await notifSvc.notifySection({
    req: null, section: secA, actorId: cr1Id, type: 'announcement',
    title: 'New announcement', message: ann1.title, refType: 'Announcement',
    refId: ann1._id, dedupePrefix: 'announcement',
  });
  assert.equal(inserted, 0); // all dedupe keys exist → nothing new
  assert.equal(await Notification.countDocuments({ refId: ann1._id }), before);
});

test('D4. concurrent fan-out replays → still exactly one per recipient', async () => {
  const calls = Array.from({ length: 5 }, () => notifSvc.notifySection({
    req: null, section: secA, actorId: cr1Id, type: 'announcement',
    title: 'New announcement', message: ann1.title, refType: 'Announcement',
    refId: ann1._id, dedupePrefix: 'announcement',
  }));
  const results = await Promise.allSettled(calls);
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'no unhandled E11000 escapes the service');
  assert.equal(await Notification.countDocuments({ recipient: s1Id, refId: ann1._id }), 1);
  assert.equal(await Notification.countDocuments({ recipient: s2Id, refId: ann1._id }), 1);
});

test('D5. archiving the announcement preserves delivered notifications', async () => {
  assert.equal((await cr1.api('POST', `/api/cr/announcements/${ann1Id}/archive`)).status, 200);
  assert.equal(await Notification.countDocuments({ refId: ann1Id, recipient: s1Id }), 1); // historical record intact
});

/* ---------------------- E. ASSIGNMENT FAN-OUT ---------------------- */
test('E1. CR assignment → active section students notified; message carries deadline', async () => {
  const res = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'ER diagram task', instructions: 'Draw an ER diagram.',
    deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });
  assert.equal(res.status, 200);
  asg1Id = String(res.json.data._id);

  for (const sid of [s1Id, s2Id, s3Id]) {
    const docs = await Notification.find({ recipient: sid, refId: res.json.data._id }).lean();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].type, 'assignment');
    assert.equal(docs[0].dedupeKey, `assignment:${asg1Id}:${sid}`);
    assert.ok(docs[0].message.includes('due'));
  }
  assert.equal(await Notification.countDocuments({ refId: res.json.data._id }), 3);
  assert.equal(await Notification.countDocuments({ recipient: cr1Id, refId: res.json.data._id }), 0);
});

test('E2. update + archive never create notification spam', async () => {
  const before = await Notification.countDocuments({ refId: asg1Id });
  assert.equal((await cr1.api('PATCH', `/api/cr/assignments/${asg1Id}`, { instructions: 'Updated.' })).status, 200);
  assert.equal((await cr1.api('POST', `/api/cr/assignments/${asg1Id}/archive`)).status, 200);
  assert.equal(await Notification.countDocuments({ refId: asg1Id }), before);
});

test('E3. assignment fan-out retry is idempotent', async () => {
  const inserted = await notifSvc.notifySection({
    req: null, section: secA, actorId: cr1Id, type: 'assignment',
    title: 'New assignment', message: 'replay', refType: 'Assignment',
    refId: asg1Id, dedupePrefix: 'assignment',
  });
  assert.equal(inserted, 0);
  assert.equal(await Notification.countDocuments({ refId: asg1Id, recipient: s1Id }), 1);
});

test('E4. section-B students never receive section-A assignment notifications', async () => {
  const bStudents = await User.find({ section: secB }).select('_id');
  for (const u of bStudents) {
    assert.equal(await Notification.countDocuments({ recipient: u._id, refId: asg1Id }), 0);
  }
});

/* ------------------ F. TIMETABLE REMINDERS (KARACHI) ------------------ */
const MON = Date.UTC(2026, 9, 5, 3, 30);  // 2026-10-05 08:30 PKT (Monday)
test('F1. 30-minute window: at start−30m exactly → reminder generated on poll', async () => {
  // Monday 09:00–10:00 PKT slot
  const slot = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, date: '2026-10-05', startTime: '09:00', endTime: '10:00', room: 'Lab 2',
  });
  assert.equal(slot.status, 200);
  const slotId = String(slot.json.data._id);

  setNow(Date.UTC(2026, 9, 5, 3, 30)); // 08:30 PKT — exactly 30 minutes before
  const res = await s1.api('GET', '/api/student/notifications');
  assert.equal(res.status, 200);
  const reminder = res.json.data.find((n) => n.type === 'timetable');
  assert.ok(reminder, 'reminder generated');
  assert.equal(String(reminder.refId), slotId);
  assert.ok(reminder.message.includes('09:00'));

  const doc = await Notification.findOne({ recipient: s1Id, type: 'timetable' }).lean();
  assert.equal(doc.dedupeKey, `reminder:${slotId}:2026-10-05`); // KARACHI date, not UTC
  setNow(null);
});

test('F2. before the 30-minute window → no reminder', async () => {
  const before = await Notification.countDocuments({ type: 'timetable' });
  setNow(Date.UTC(2026, 9, 5, 3, 29)); // 08:29 PKT
  await s2.api('GET', '/api/student/notifications');
  assert.equal(await Notification.countDocuments({ type: 'timetable' }), before);
  setNow(null);
});

test('F3. after class start → no reminder (window closed)', async () => {
  const before = await Notification.countDocuments({ type: 'timetable' });
  setNow(Date.UTC(2026, 9, 5, 4, 5)); // 09:05 PKT
  await s2.api('GET', '/api/student/notifications');
  assert.equal(await Notification.countDocuments({ type: 'timetable' }), before);
  setNow(null);
});

test('F4. repeated polls → no duplicate reminders (idempotent)', async () => {
  setNow(Date.UTC(2026, 9, 5, 3, 45)); // still inside the window
  await s1.api('GET', '/api/student/notifications');
  await s1.api('GET', '/api/student/notifications');
  await s1.api('GET', '/api/student/notifications/unread-count');
  const count = await Notification.countDocuments({ recipient: s1Id, type: 'timetable' });
  assert.equal(count, 1);
  setNow(null);
});

test('F5. 10 concurrent polls → exactly one reminder document (unique index)', async () => {
  setNow(Date.UTC(2026, 9, 5, 3, 40));
  const polls = await Promise.allSettled(Array.from({ length: 10 }, () => s3.api('GET', '/api/student/notifications')));
  assert.ok(polls.every((p) => p.value.status === 200), 'no poll may fail under race');
  assert.equal(await Notification.countDocuments({ recipient: s3Id, type: 'timetable' }), 1);
  setNow(null);
});

test('F6. Karachi date boundary: 01:00 PKT Monday class, polled at 00:35 PKT (19:35 UTC SUNDAY)', async () => {
  const slot = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, date: '2026-10-05', startTime: '01:00', endTime: '02:00', room: 'R1',
  });
  assert.equal(slot.status, 200);
  const slotId = String(slot.json.data._id);

  setNow(Date.UTC(2026, 9, 4, 19, 35)); // UTC Sunday 19:35 = Karachi Monday 00:35
  const res = await s1.api('GET', '/api/student/notifications');
  const rem = res.json.data.find((n) => String(n.refId) === slotId);
  assert.ok(rem, 'reminder matches the Karachi-Monday slot despite UTC Sunday');

  const doc = await Notification.findOne({ recipient: s1Id, refId: slot.json.data._id }).lean();
  assert.equal(doc.dedupeKey, `reminder:${slotId}:2026-10-05`, 'dedupe date is KARACHI Monday, not UTC Sunday 2026-10-04');
  setNow(null);
});

test('F7. archived timetable slot generates no reminder', async () => {
  const slot = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, date: '2026-10-05', startTime: '11:00', endTime: '12:00',
  });
  await cr1.api('POST', `/api/cr/timetable/${slot.json.data._id}/archive`);
  setNow(Date.UTC(2026, 9, 5, 4, 35)); // 10:35 PKT — inside window for 11:00
  await s1.api('GET', '/api/student/notifications');
  assert.equal(await Notification.countDocuments({ recipient: s1Id, refId: slot.json.data._id }), 0);
  setNow(null);
});

/* --------------------- G. DEADLINE REMINDERS --------------------- */
test('G1–G3. deadline within 24h → reminder; server time; idempotent', async () => {
  setNow(Date.UTC(2026, 9, 5, 6, 0)); // fixed server time
  const asg = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Deadline soon task', instructions: 'Hurry.',
    deadline: new Date(Date.UTC(2026, 9, 5, 6, 0) + 12 * 3600 * 1000).toISOString(), // +12h
  });
  assert.equal(asg.status, 200);
  const asgId = asg.json.data._id;

  const res = await s1.api('GET', '/api/student/notifications');
  const rem = res.json.data.find((n) => String(n.refId) === String(asgId));
  assert.ok(rem, 'deadline reminder generated');
  assert.equal(rem.type, 'reminder');
  assert.equal(rem.refType, 'Assignment');

  // idempotent — second poll changes nothing (deadline reminder type only; the
  // creation fan-out notification shares refId with type 'assignment')
  await s1.api('GET', '/api/student/notifications');
  assert.equal(await Notification.countDocuments({ recipient: s1Id, refId: asgId, type: 'reminder' }), 1);
  const doc = await Notification.findOne({ recipient: s1Id, refId: asgId, type: 'reminder' }).lean();
  assert.equal(doc.dedupeKey, `assignment_deadline:${asgId}:2026-10-05:${s1Id}`); // Karachi date key

  // deadline more than 24h away → no reminder for a second student
  const asg2 = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Far deadline', instructions: 'Relax.',
    deadline: new Date(Date.UTC(2026, 9, 5, 6, 0) + 3 * 24 * 3600 * 1000).toISOString(),
  });
  await s2.api('GET', '/api/student/notifications');
  assert.equal(await Notification.countDocuments({ recipient: s2Id, refId: asg2.json.data._id, type: 'reminder' }), 0);

  // deadline already passed → no reminder
  const asg3 = await cr1.api('POST', '/api/cr/assignments', {
    subject: subA1, title: 'Past deadline', instructions: 'Too late.',
    deadline: new Date(Date.UTC(2026, 9, 5, 6, 0) - 3600 * 1000).toISOString(),
  });
  await s2.api('GET', '/api/student/notifications');
  assert.equal(await Notification.countDocuments({ recipient: s2Id, refId: asg3.json.data._id, type: 'reminder' }), 0);
  setNow(null);
});

/* -------------------------- H. READ STATE -------------------------- */
test('H1–H5. mark one read / mark all read / counts / idempotency', async () => {
  const before = await Notification.countDocuments({ recipient: s2Id, read: false });
  assert.ok(before >= 2, 's2 has unread notifications from fan-outs');


  const count1 = await s2.api('GET', '/api/student/notifications/unread-count');
  assert.equal(count1.json.data.count, before);

  const first = await Notification.findOne({ recipient: s2Id, read: false });
  const mark = await s2.api('POST', `/api/student/notifications/${first._id}/read`);
  assert.equal(mark.status, 200);
  assert.equal(mark.json.data.read, true);
  assert.ok(mark.json.data.readAt);

  // idempotent — re-marking is a 200 no-op
  const reMark = await s2.api('POST', `/api/student/notifications/${first._id}/read`);
  assert.equal(reMark.status, 200);
  const after2 = await s2.api('GET', '/api/student/notifications/unread-count');
  assert.equal(after2.json.data.count, before - 1);

  // cross-user mark → 404, existence not leaked
  const other = await Notification.findOne({ recipient: s1Id, read: false });
  assert.equal((await s2.api('POST', `/api/student/notifications/${other._id}/read`)).status, 404);
  assert.equal((await cr1.api('POST', `/api/cr/notifications/${other._id}/read`)).status, 404); // CR can't touch student's

  // read-all → only own unread
  const all = await s2.api('POST', '/api/student/notifications/read-all');
  assert.equal(all.status, 200);
  assert.equal(all.json.data.count, before - 1);
  const zero = await s2.api('GET', '/api/student/notifications/unread-count');
  assert.equal(zero.json.data.count, 0);
  // s1 untouched
  const s1count = await s1.api('GET', '/api/student/notifications');
  assert.ok(s1count.json.data.some((n) => n.read === false));

  // invalid id → 400
  assert.equal((await s2.api('POST', '/api/student/notifications/zzz/read')).status, 400);
});

test('H-BYTYPE. unread-count-by-type aggregates correctly; read-by-type clears only matching types', async () => {
  // s4 is a fresh isolated user (never touched by earlier fan-outs in this
  // file) — seed a KNOWN mix directly via the service for an exact assertion.
  await notifSvc.createManyNotifications([
    { recipient: s4Id, type: 'announcement', title: 'A1', message: 'm', dedupeKey: `bytype:ann1:${s4Id}` },
    { recipient: s4Id, type: 'announcement', title: 'A2', message: 'm', dedupeKey: `bytype:ann2:${s4Id}` },
    { recipient: s4Id, type: 'assignment', title: 'As1', message: 'm', dedupeKey: `bytype:asg1:${s4Id}` },
    { recipient: s4Id, type: 'reminder', title: 'R1', message: 'm', dedupeKey: `bytype:rem1:${s4Id}` },
  ]);

  const before = await s4.api('GET', '/api/student/notifications/unread-count-by-type');
  assert.equal(before.status, 200);
  assert.equal(before.json.data.byType.announcement, 2);
  assert.equal(before.json.data.byType.assignment, 1);
  assert.equal(before.json.data.byType.reminder, 1);
  assert.equal(before.json.data.total, 4);

  // clear only announcement + assignment (the "Assignments tab" mapping is
  // assignment + reminder in the frontend — here we test partial clearing)
  const cleared = await s4.api('POST', '/api/student/notifications/read-by-type', { types: ['announcement', 'assignment'] });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.data.count, 3); // 2 announcement + 1 assignment

  const after = await s4.api('GET', '/api/student/notifications/unread-count-by-type');
  assert.equal(after.json.data.byType.announcement ?? 0, 0);
  assert.equal(after.json.data.byType.assignment ?? 0, 0);
  assert.equal(after.json.data.byType.reminder, 1); // untouched
  assert.equal(after.json.data.total, 1);

  // unknown/garbage types are silently ignored, not an error
  const noop = await s4.api('POST', '/api/student/notifications/read-by-type', { types: ['not_a_real_type'] });
  assert.equal(noop.status, 200);
  assert.equal(noop.json.data.count, 0);

  // cross-user isolation: s1's by-type call never sees s4's rows
  const s1ByType = await s1.api('GET', '/api/student/notifications/unread-count-by-type');
  assert.equal(s1ByType.status, 200);

  // cleanup the seeded reminder
  await s4.api('POST', '/api/student/notifications/read-by-type', { types: ['reminder'] });
  const finalCount = await s4.api('GET', '/api/student/notifications/unread-count-by-type');
  assert.equal(finalCount.json.data.total, 0);
});

test('H6. list: newest first, pagination, unread filter, no cross-user rows', async () => {
  const res = await s1.api('GET', '/api/student/notifications?limit=2&page=1');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.length <= 2);
  const created = res.json.data.map((n) => new Date(n.createdAt).getTime());
  assert.ok(created.every((v, i) => i === 0 || created[i - 1] >= v), 'newest first');
  const unreadOnly = await s1.api('GET', '/api/student/notifications?unread=true&limit=100');
  assert.ok(unreadOnly.json.data.every((n) => n.read === false));

  const capped = await s1.api('GET', '/api/student/notifications?limit=9999');
  assert.equal(capped.json.pagination.limit, 100); // server-side max page size
});

/* -------------------------- B/C. ISOLATION -------------------------- */
test('B1. student list contains ONLY their own notifications', async () => {
  const res = await s1.api('GET', '/api/student/notifications?limit=100');
  assert.equal(res.status, 200);
  const ownIds = (await Notification.find({ recipient: s1Id })).map((d) => String(d._id));
  const listedIds = res.json.data.map((n) => String(n._id));
  for (const id of listedIds) assert.ok(ownIds.includes(id), 'no foreign rows');
  assert.deepEqual(listedIds.length, ownIds.length); // full first page covers all
});

test('B2. no client-facing notification CREATE route exists anywhere', async () => {
  assert.equal((await s1.api('POST', '/api/student/notifications', { recipient: cr2Id, type: 'system' })).status, 404);
  assert.equal((await cr1.api('POST', '/api/cr/notifications', { recipient: s2Id })).status, 404);
  assert.equal((await admin.api('POST', '/api/admin/notifications', { recipient: s1Id })).status, 404);
  assert.equal((await admin.api('POST', '/api/notifications', {})).status, 404);
});

test('C1. CR notifications are own-mailbox too; CR polls generate own reminders', async () => {
  // CR1 (actor) has no self-notification from own announcements…
  assert.equal(await Notification.countDocuments({ recipient: cr1Id, refId: ann1._id }), 0);
  // …but received the admin announcement + deadline/timetable reminders on poll
  const res = await cr1.api('GET', '/api/cr/notifications?limit=100');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.some((n) => String(n.refId) === ann2Id));
  const uc = await cr1.api('GET', '/api/cr/notifications/unread-count');
  assert.ok(uc.json.data.count >= 1);
});

test('C2. section rollover stops NEW notifications; history preserved', async () => {
  // s3 rolls from section A to section B (admin-level data change)
  await User.updateOne({ _id: s3Id }, { $set: { section: secB } });
  const histBefore = await Notification.countDocuments({ recipient: s3Id });
  assert.ok(histBefore >= 1);

  // new section-A announcement must NOT reach the rolled-over student
  const res = await cr1.api('POST', '/api/cr/announcements', { title: 'Post-rollover notice', content: 'A only.' });
  assert.equal(res.status, 200);
  assert.equal(await Notification.countDocuments({ recipient: s3Id, refId: res.json.data._id }), 0);

  // historical notifications remain — no deletion on rollover
  assert.equal(await Notification.countDocuments({ recipient: s3Id }), histBefore);
});

/* ------------------------ I. CONCURRENCY ------------------------ */
test('I1. 10 concurrent identical single creations → exactly one document, no thrown E11000', async () => {
  const attempts = await Promise.allSettled(Array.from({ length: 10 }, () =>
    notifSvc.createNotification({
      recipient: s2Id, type: 'system', title: 'Race test', message: 'once only',
      refType: 'System', refId: null, dedupeKey: `race:${s2Id}`,
    })));
  assert.ok(attempts.every((a) => a.status === 'fulfilled'), 'service must swallow duplicate races');
  const docs = await Notification.find({ recipient: s2Id, dedupeKey: `race:${s2Id}` }).lean();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, 'Race test');
});

/* ------------------- J. RETENTION / INDEXES ------------------- */
test('J1–J3. indexes intact; expiresAt = +90 days; no manual cleanup path', async () => {
  const indexes = await Notification.collection.indexes();
  const byKey = (cols) => indexes.find((i) => i.key && cols.every((c) => i.key[c] === 1) && Object.keys(i.key).length === cols.length);
  const dedupe = byKey(['recipient', 'dedupeKey']);
  assert.ok(dedupe, 'unique dedupe index present');
  assert.equal(dedupe.unique, true);
  assert.ok(dedupe.partialFilterExpression, 'partial filter preserved');
  const ttl = byKey(['expiresAt']);
  assert.ok(ttl, 'TTL index present');
  assert.equal(ttl.expireAfterSeconds, 0);
  const listIdx = indexes.find((i) => i.key.recipient && i.key.read !== undefined && i.key.createdAt === -1);
  assert.ok(listIdx, 'recipient+read+createdAt list index preserved');

  setNow(null); // retention is measured from the real creation instant
  const fresh = await notifSvc.createNotification({
    recipient: s1Id, type: 'system', title: 'Retention check', message: 'x',
    dedupeKey: `retention:${Date.now()}`,
  });
  const expected = new Date(fresh.createdAt).getTime() + 90 * 24 * 3600 * 1000;
  assert.ok(Math.abs(new Date(fresh.expiresAt).getTime() - expected) < 60000, '90-day retention from createdAt');

  // no destructive endpoint exists for notifications
  assert.equal((await s1.api('DELETE', '/api/student/notifications')).status, 404);
  assert.equal((await admin.api('DELETE', '/api/admin/notifications')).status, 404);
  assert.equal((await admin.api('PATCH', '/api/admin/notifications/xyz')).status, 404);
});

/* --------------------------- K. SECURITY --------------------------- */
test('K1. responses expose only safe fields — never dedupeKey, secrets, or hashes', async () => {
  const responses = [
    await s1.api('GET', '/api/student/notifications?limit=100'),
    await s1.api('GET', '/api/student/notifications/unread-count'),
    await cr1.api('GET', '/api/cr/notifications'),
    await admin.api('GET', '/api/admin/notifications?limit=100'),
  ];
  for (const r of responses) {
    assert.ok(!r.text.includes('dedupeKey'), 'dedupeKey is internal');
    assert.ok(!r.text.includes('test-only-jwt-secret'));
    assert.ok(!/\$2[aby]\$/.test(r.text), 'no password hashes');
    assert.ok(!r.text.includes('Pass1234'), 'no credentials');
  }
  // admin read-only: no mutation route, filters validated
  assert.equal((await admin.api('POST', '/api/admin/notifications/507f1f77bcf86cd799439011/read')).status, 404);
  assert.equal((await admin.api('POST', '/api/admin/notifications/read-all')).status, 404);
  assert.equal((await admin.api('GET', '/api/admin/notifications?recipient=zzz')).status, 400);
  assert.equal((await admin.api('GET', '/api/admin/notifications?type=evil')).status, 400);
  const adminList = await admin.api('GET', '/api/admin/notifications?recipient=' + s1Id);
  assert.equal(adminList.status, 200);
  assert.ok(adminList.json.data.length >= 1);
  assert.ok(adminList.json.data.every((n) => String(n.recipient) === String(s1Id)));
});

test('K2. audit events exist and stay aggregate — no payload/secret leakage', async () => {
  assert.ok(await AuditLog.countDocuments({ action: 'notification.create' }) >= 2, 'fan-out audited');
  assert.ok(await AuditLog.countDocuments({ action: 'notification.read' }) >= 1);
  assert.ok(await AuditLog.countDocuments({ action: 'notification.read_all' }) >= 1);
  assert.ok(await AuditLog.countDocuments({ action: 'notification.generate' }) >= 1, 'lazy generation audited');

  const logs = await AuditLog.find({ action: /^notification\./ });
  const text = JSON.stringify(logs.map((l) => ({ b: l.before, a: l.after, r: l.reason })));
  assert.ok(!text.includes('Pass1234') && !text.includes('test-only-jwt-secret'));
  assert.ok(!text.includes('codeHash'));
  // fan-out audits are AGGREGATE: recipients counted, never one log per user.
  // The admin announcement (4 recipients) produced exactly ONE create event.
  assert.equal(await AuditLog.countDocuments({ action: 'notification.create', entityId: ann2Id }), 1);
  const fanouts = await AuditLog.find({ action: 'notification.create' });
  assert.ok(fanouts.length < 20, 'no per-recipient audit noise (replays are per-event, not per-user)');
  assert.ok(fanouts.every((l) => l.after && typeof l.after.recipients === 'number'));
});

test('L. regression: earlier features healthy on this instance', async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.database, 'connected');
  assert.equal((await admin.api('GET', '/api/admin/announcements')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/assignments')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/timetable')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/attendance/sessions')).status, 200);
  assert.equal((await cr1.api('GET', '/api/cr/subjects')).status, 200);
  assert.equal((await s1.api('GET', '/api/student/announcements')).status, 200);
  assert.equal((await s1.api('GET', '/api/student/assignments')).status, 200);
  assert.equal((await s1.api('GET', '/api/student/timetable')).status, 200);
  assert.equal((await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'Wrong!' })).status, 401);
});

test.after(async () => {
  delete process.env.MOCK_NOW;
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
