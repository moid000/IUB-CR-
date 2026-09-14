/**
 * STEP 7 tests — timetable. Isolated in-memory REPLICA SET (transactions);
 * never touches Atlas. Wall-clock HH:MM values are asserted byte-for-byte —
 * recurring Asia/Karachi times are never converted to UTC.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('timetable_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Section, Subject, Timetable, AuditLog } = models;
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
const cr1 = makeSession();     // section A
const cr2 = makeSession();     // section B
const student1 = makeSession(); // section A
const student2 = makeSession(); // section B

let deptCS, session1, secA, secB, secC, subA1, subA2, subB1, subC1;
let cr1Id, cr2Id, student1Id;
let tBase, tAdmin, tB1; // timetable ids

test('fixtures: hierarchy + users', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  deptCS = (await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  session1 = (await admin.api('POST', '/api/admin/sessions', { name: '2027–28' })).json.data._id;
  secA = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5A' })).json.data._id;
  secB = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 5, name: '5B' })).json.data._id;
  secC = (await admin.api('POST', '/api/admin/sections', { department: deptCS, session: session1, semester: 6, name: '6C' })).json.data._id;

  const hash = await bcrypt.hash('CrPass123!', 10);
  cr1Id = (await User.create({ name: 'CR One', email: 'cr1@test.local', phone: '+923001110001', role: 'cr', registrationStatus: 'active', emailVerified: true, password: hash, section: secA }))._id;
  cr2Id = (await User.create({ name: 'CR Two', email: 'cr2@test.local', phone: '+923001110002', role: 'cr', registrationStatus: 'active', emailVerified: true, password: hash, section: secB }))._id;
  student1Id = (await User.create({ name: 'Student One', email: 's1@test.local', phone: '+923001110003', role: 'student', registrationStatus: 'active', emailVerified: true, password: hash, section: secA, rollNo: 'R-001' }))._id;
  await User.create({ name: 'Student Two', email: 's2@test.local', phone: '+923001110004', role: 'student', registrationStatus: 'active', emailVerified: true, password: hash, section: secB, rollNo: 'R-002' });
  await Section.updateOne({ _id: secA }, { $set: { cr: cr1Id } });
  await Section.updateOne({ _id: secB }, { $set: { cr: cr2Id } });

  subA1 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Databases', code: 'DB-201' })).json.data._id;
  subA2 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Networking', code: 'NET-1' })).json.data._id;
  subB1 = (await admin.api('POST', '/api/admin/subjects', { section: secB, name: 'Databases', code: 'DB-201' })).json.data._id;
  subC1 = (await admin.api('POST', '/api/admin/subjects', { section: secC, name: 'Old Course', code: 'OLD-1' })).json.data._id;

  assert.equal((await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await cr2.api('POST', '/api/auth/login', { email: 'cr2@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await student1.api('POST', '/api/auth/login', { email: 's1@test.local', password: 'CrPass123!' })).status, 200);
  assert.equal((await student2.api('POST', '/api/auth/login', { email: 's2@test.local', password: 'CrPass123!' })).status, 200);
});

/* ============================ BASIC (1–6) ============================ */
test('1. admin creates timetable entry (timezone byte-for-byte)', async () => {
  const res = await admin.api('POST', '/api/admin/timetable', {
    section: secA, subject: subA1, day: 'monday', startTime: '09:00', endTime: '10:00', room: 'Lab 3',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.day, 'monday');
  assert.equal(res.json.data.startTime, '09:00'); // string, never a UTC timestamp
  assert.equal(res.json.data.endTime, '10:00');
  assert.equal(res.json.data.status, 'active');
  assert.equal(res.json.data.room, 'Lab 3');
  tAdmin = res.json.data._id;
  const got = await admin.api('GET', `/api/admin/timetable/${tAdmin}`);
  assert.equal(got.json.data.subject.name, 'Databases'); // populated on read
  assert.equal(got.json.data.createdBy.name, 'Administrator');

  // 28. wall-clock never converted — DB value identical to input
  const doc = await Timetable.findById(tAdmin);
  assert.equal(typeof doc.startTime, 'string');
  assert.equal(doc.startTime, '09:00');

  // day normalization: case-insensitive input → canonical lowercase
  const norm = await admin.api('POST', '/api/admin/timetable', {
    section: secA, subject: subA1, day: '  MONDAY ', startTime: '11:00', endTime: '12:00',
  });
  assert.equal(norm.status, 200);
  assert.equal(norm.json.data.day, 'monday');
  await Timetable.findByIdAndDelete(norm.json.data._id); // cleanup for overlap tests
});

test('2. CR creates timetable in own section (injections ignored)', async () => {
  const res = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA2, day: 'monday', startTime: '10:00', endTime: '11:00',
    section: secB, sectionId: secB, createdBy: student1Id, author: student1Id, role: 'admin', status: 'archived',
  });
  assert.equal(res.status, 200);
  const doc = await Timetable.findById(res.json.data._id);
  assert.equal(String(doc.section), String(secA)); // server-derived
  assert.equal(String(doc.createdBy), String(cr1Id)); // (45) createdBy injection blocked
  assert.equal(doc.status, 'active'); // (47) status injection blocked
  tBase = res.json.data._id;
});

test('3. student reads timetable (own section only)', async () => {
  const res = await student1.api('GET', '/api/student/timetable');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.length >= 2);
  assert.ok(res.json.data.every((t) => String(t.section) === String(secA)));
  const one = await student1.api('GET', `/api/student/timetable/${tBase}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.data.startTime, '10:00');
});

test('4–6. student cannot create/update/archive', async () => {
  assert.equal((await student1.api('POST', '/api/student/timetable', {})).status, 404); // no such route
  assert.equal((await student1.api('POST', '/api/cr/timetable', { subject: subA1, day: 'tuesday', startTime: '09:00', endTime: '10:00' })).status, 403); // (4)
  assert.equal((await student1.api('POST', '/api/admin/timetable', { section: secA, subject: subA1, day: 'tuesday', startTime: '09:00', endTime: '10:00' })).status, 403);
  assert.equal((await student1.api('PATCH', `/api/cr/timetable/${tBase}`, { room: 'X' })).status, 403); // (5)
  assert.equal((await student1.api('POST', `/api/cr/timetable/${tBase}/archive`)).status, 403); // (6)
  const doc = await Timetable.findById(tBase);
  assert.equal(doc.status, 'active'); // untouched
});

/* =========================== VALIDATION (7–15) =========================== */
test('7–11. section/subject relationships validated', async () => {
  // invalid section id
  assert.equal((await admin.api('POST', '/api/admin/timetable', {
    section: 'zzz', subject: subA1, day: 'monday', startTime: '13:00', endTime: '14:00',
  })).status, 400);
  // non-existent section
  assert.equal((await admin.api('POST', '/api/admin/timetable', {
    section: '507f1f77bcf86cd799439011', subject: subA1, day: 'monday', startTime: '13:00', endTime: '14:00',
  })).status, 400);
  // invalid subject id
  assert.equal((await admin.api('POST', '/api/admin/timetable', {
    section: secA, subject: 'zzz', day: 'monday', startTime: '13:00', endTime: '14:00',
  })).status, 400);
  // (9) subject from another section
  const cross = await admin.api('POST', '/api/admin/timetable', {
    section: secA, subject: subB1, day: 'monday', startTime: '13:00', endTime: '14:00',
  });
  assert.equal(cross.status, 400);
  assert.match(cross.json.message, /does not belong/i);
  // (10) archived section
  assert.equal((await admin.api('POST', `/api/admin/sections/${secC}/archive`)).status, 200);
  const archSec = await admin.api('POST', '/api/admin/timetable', {
    section: secC, subject: subC1, day: 'monday', startTime: '13:00', endTime: '14:00',
  });
  assert.equal(archSec.status, 400);
  assert.match(archSec.json.message, /archived/i);
  // (11) archived subject
  assert.equal((await admin.api('POST', `/api/admin/subjects/${subC1}/archive`)).status, 200);
  // subC1's section archived too — use a fresh archived subject in an active section
  const subA3 = (await admin.api('POST', '/api/admin/subjects', { section: secA, name: 'Old Subject', code: 'OLD-A' })).json.data._id;
  assert.equal((await admin.api('POST', `/api/admin/subjects/${subA3}/archive`)).status, 200);
  const archSub = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA3, day: 'friday', startTime: '09:00', endTime: '10:00',
  });
  assert.equal(archSub.status, 400);
  assert.match(archSub.json.message, /archived/i);
});

test('12–14. day + time format validation', async () => {
  for (const day of ['funday', 'sunday', 'mon', '', null, 42]) { // (12, 13)
    const res = await cr1.api('POST', '/api/cr/timetable', {
      subject: subA1, day, startTime: '13:00', endTime: '14:00',
    });
    assert.equal(res.status, 400, `day=${JSON.stringify(day)}`);
    if (day === 'sunday' || day === 'mon') assert.match(res.json.message, /day must be one of/i);
  }
  // (14) invalid HH:MM — rejected by strict zero-padded 24h rule
  for (const [startTime, endTime] of [['8:00 AM', '10:00'], ['25:00', '26:00'], ['09:75', '10:00'], ['', '10:00'], ['9:00', '10:00'], [null, '10:00']]) {
    const res = await cr1.api('POST', '/api/cr/timetable', {
      subject: subA1, day: 'wednesday', startTime, endTime,
    });
    assert.equal(res.status, 400, `startTime=${JSON.stringify(startTime)}`);
  }
  const badEnd = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, day: 'wednesday', startTime: '13:00', endTime: '13:60',
  });
  assert.equal(badEnd.status, 400);
  assert.equal(await Timetable.countDocuments({ day: 'wednesday' }), 0);
});

test('15. startTime >= endTime rejected', async () => {
  const equal = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, day: 'thursday', startTime: '09:00', endTime: '09:00',
  });
  assert.equal(equal.status, 400);
  const inverted = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, day: 'thursday', startTime: '10:00', endTime: '09:00',
  });
  assert.equal(inverted.status, 400);
  assert.equal(await Timetable.countDocuments({ day: 'thursday' }), 0);
});

/* ============================ OVERLAP (16–27) ============================ */
const overlapAttempt = (start, end, day = 'monday', section = undefined, subject = subA1) =>
  (section ? admin.api('POST', '/api/admin/timetable', { section, subject, day, startTime: start, endTime: end })
    : cr1.api('POST', '/api/cr/timetable', { subject, day, startTime: start, endTime: end }));

test('16–20. overlapping creations rejected with 409', async () => {
  // existing: secA monday 09:00–10:00 (tAdmin)
  assert.equal((await overlapAttempt('09:00', '10:00')).status, 409); // (16) exact duplicate
  assert.equal((await overlapAttempt('09:30', '10:30')).status, 409); // (17) overlap at start
  assert.equal((await overlapAttempt('08:30', '09:15')).status, 409); // (18) overlap at end
  assert.equal((await overlapAttempt('08:00', '11:00')).status, 409); // (19) existing inside new
  assert.equal((await overlapAttempt('09:15', '09:45')).status, 409); // (20) new inside existing
  const msg = (await overlapAttempt('09:00', '10:00')).json.message;
  assert.match(msg, /overlaps/i);
});

test('21–24. boundaries, other days, other sections allowed', async () => {
  // fresh base slot (saturday 14:00–15:00) — monday already carries tAdmin + tBase
  assert.equal((await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, day: 'saturday', startTime: '14:00', endTime: '15:00',
  })).status, 200);
  assert.equal((await overlapAttempt('13:00', '14:00', 'saturday')).status, 200); // (21) end→start boundary
  assert.equal((await overlapAttempt('15:00', '16:00', 'saturday')).status, 200); // (22) start→end boundary
  assert.equal((await overlapAttempt('09:00', '10:00', 'tuesday')).status, 200); // (23) different day
  assert.equal((await overlapAttempt('09:00', '10:00', 'monday', secB, subB1)).status, 200); // (24) different section
});

test('25. archived overlapping entry does not block', async () => {
  // archive the tuesday 09:00–10:00 entry, then recreate the same slot → allowed
  const tueDoc = await Timetable.findOne({ section: secA, day: 'tuesday' });
  assert.equal((await cr1.api('POST', `/api/cr/timetable/${tueDoc._id}/archive`)).status, 200);
  const res = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, day: 'tuesday', startTime: '09:00', endTime: '10:00',
  });
  assert.equal(res.status, 200); // archived slot no longer blocks
});

test('26–27. update overlap rejected; self excluded', async () => {
  // create a clean slot: wednesday 13:00–14:00
  const t13 = (await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, day: 'wednesday', startTime: '13:00', endTime: '14:00',
  })).json.data._id;
  // (26) moving it onto monday 09:30–10:30 overlaps tAdmin → 409
  const bad = await cr1.api('PATCH', `/api/cr/timetable/${t13}`, {
    day: 'monday', startTime: '09:30', endTime: '10:30',
  });
  assert.equal(bad.status, 409);
  assert.match(bad.json.message, /overlaps/i);
  // (27) updating itself (13:00 → 13:30) excludes itself from detection → 200
  const ok = await cr1.api('PATCH', `/api/cr/timetable/${t13}`, {
    startTime: '13:30', endTime: '14:00',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.startTime, '13:30');
  // invalid time on update also rejected
  assert.equal((await cr1.api('PATCH', `/api/cr/timetable/${t13}`, { endTime: '13:00' })).status, 400);
});

/* ============================ ISOLATION (28–35) ============================ */
test('28–32. CR isolation — own section only, cross-section 404', async () => {
  tB1 = (await cr2.api('POST', '/api/cr/timetable', {
    subject: subB1, day: 'friday', startTime: '10:00', endTime: '11:00',
  })).json.data._id; // (29) cr2 create with injected section lands in own section
  assert.equal(String((await Timetable.findById(tB1)).section), String(secB));

  const list = await cr1.api('GET', '/api/cr/timetable');
  assert.ok(list.json.data.every((t) => String(t.section) === String(secA))); // (28)
  assert.ok(!list.json.data.some((t) => String(t._id) === String(tB1)));

  assert.equal((await cr1.api('GET', `/api/cr/timetable/${tB1}`)).status, 404); // (32)
  assert.equal((await cr1.api('PATCH', `/api/cr/timetable/${tB1}`, { room: 'Hacked' })).status, 404); // (30)
  assert.equal((await cr1.api('POST', `/api/cr/timetable/${tB1}/archive`)).status, 404); // (31)
  assert.equal(String((await Timetable.findById(tB1)).section), String(secB)); // untouched
});

test('33–35. student isolation; admin cross-section', async () => {
  const list = await student1.api('GET', '/api/student/timetable');
  assert.ok(list.json.data.every((t) => String(t.section) === String(secA))); // (33)
  assert.equal((await student1.api('GET', `/api/student/timetable/${tB1}`)).status, 404); // (34)
  // student-supplied sectionId param is ignored for ownership
  const scoped = await student1.api('GET', `/api/student/timetable?sectionId=${secB}`);
  assert.ok(scoped.json.data.every((t) => String(t.section) === String(secA)));
  const adminList = await admin.api('GET', '/api/admin/timetable');
  assert.ok(adminList.json.data.some((t) => String(t.section) === String(secA)));
  assert.ok(adminList.json.data.some((t) => String(t.section) === String(secB))); // (35)
  // CR list also honors day/status/subjectId filters, still scoped
  const byDay = await cr1.api('GET', '/api/cr/timetable?day=monday&status=active');
  assert.ok(byDay.json.data.every((t) => t.day === 'monday' && t.status === 'active'));
  const bySubject = await cr1.api('GET', `/api/cr/timetable?subjectId=${subA2}`);
  assert.ok(bySubject.json.data.every((t) => String(t.subject._id) === String(subA2)));
});

/* ============================ ARCHIVE (36–40) ============================ */
test('36–40. archive preserves everything; duplicate 409; readable; unblocks slot', async () => {
  const arch = await cr1.api('POST', `/api/cr/timetable/${tBase}/archive`);
  assert.equal(arch.status, 200); // (36)
  const doc = await Timetable.findById(tBase);
  assert.equal(doc.status, 'archived');
  assert.equal(doc.day, 'monday'); // preserved
  assert.equal(doc.startTime, '10:00'); // preserved
  assert.equal(doc.endTime, '11:00'); // preserved
  assert.equal(String(doc.subject), String(subA2)); // preserved
  assert.equal(String(doc.createdBy), String(cr1Id)); // preserved
  assert.ok(doc.createdAt && doc.updatedAt); // timestamps preserved

  assert.equal((await cr1.api('PATCH', `/api/cr/timetable/${tBase}`, { room: 'X' })).status, 400); // (37)
  assert.equal((await cr1.api('POST', `/api/cr/timetable/${tBase}/archive`)).status, 409); // (38)
  assert.equal((await student1.api('GET', `/api/student/timetable/${tBase}`)).status, 200); // (39) readable
  // (40) the archived slot (monday 10:00–11:00) no longer blocks
  const reuse = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, day: 'monday', startTime: '10:00', endTime: '11:00',
  });
  assert.equal(reuse.status, 200);
});

/* ============================ ORDERING (41–43) ============================ */
test('41–43. monday→saturday ordering, startTime within day, pagination cap', async () => {
  // secA already has: monday 08:00-09:00, 09:00-10:00, 10:00-11:00 (reuse), wednesday 13:30-14:00
  await cr1.api('POST', '/api/cr/timetable', { subject: subA1, day: 'saturday', startTime: '08:00', endTime: '09:00' });
  await cr1.api('POST', '/api/cr/timetable', { subject: subA2, day: 'monday', startTime: '14:00', endTime: '15:00' });
  await cr1.api('POST', '/api/cr/timetable', { subject: subA2, day: 'friday', startTime: '09:00', endTime: '10:00' });

  const list = await student1.api('GET', '/api/student/timetable');
  const days = list.json.data.map((t) => t.day);
  const uniqDays = [...new Set(days)];
  assert.deepEqual(uniqDays, [...uniqDays].sort((a, b) =>
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(a)
    - ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(b))); // (41)
  const monday = list.json.data.filter((t) => t.day === 'monday');
  const mondayTimes = monday.map((t) => t.startTime);
  assert.deepEqual(mondayTimes, [...mondayTimes].sort()); // (42) startTime ordering
  assert.deepEqual(monday.map((t) => t.section), monday.map(() => monday[0].section));

  const page = await admin.api('GET', '/api/admin/timetable?limit=2&page=2');
  assert.equal(page.json.data.length, 2);
  assert.ok(page.json.pagination.total >= 5);
  const capped = await admin.api('GET', '/api/admin/timetable?limit=9999');
  assert.equal(capped.json.pagination.limit, 100); // (43)
  const crCapped = await cr1.api('GET', '/api/cr/timetable?limit=5000');
  assert.equal(crCapped.json.pagination.limit, 100);
});

/* ============================ SECURITY (44–51) ============================ */
test('44–48. injections blocked for CR (section/createdBy/role/status/ownership)', async () => {
  const res = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, day: 'thursday', startTime: '09:00', endTime: '10:00',
    section: secB, sectionId: secB, createdBy: student1Id, role: 'admin', status: 'archived', pastMembers: [student1Id],
  });
  assert.equal(res.status, 200);
  const doc = await Timetable.findById(res.json.data._id);
  assert.equal(String(doc.section), String(secA)); // (44) section injection blocked
  assert.equal(String(doc.createdBy), String(cr1Id)); // (45) createdBy blocked
  assert.equal(doc.status, 'active'); // (47) status blocked
  // role/ownership fields don't even exist on the model — silently ignored
  // (46/48) PATCH ownership: section never moves for CR
  await cr1.api('PATCH', `/api/cr/timetable/${res.json.data._id}`, { section: secB, createdBy: student1Id });
  const after = await Timetable.findById(res.json.data._id);
  assert.equal(String(after.section), String(secA));
  assert.equal(String(after.createdBy), String(cr1Id));
  await cr1.api('POST', `/api/cr/timetable/${res.json.data._id}/archive`);
});

test('49. invalid ObjectId → 400 (never 500)', async () => {
  assert.equal((await admin.api('GET', '/api/admin/timetable/zzz')).status, 400);
  assert.equal((await cr1.api('GET', '/api/cr/timetable/zzz')).status, 400);
  assert.equal((await student1.api('GET', '/api/student/timetable/zzz')).status, 400);
  assert.equal((await admin.api('GET', '/api/admin/timetable?sectionId=bad')).status, 400);
  assert.equal((await admin.api('GET', '/api/admin/timetable?subjectId=bad')).status, 400);
  assert.equal((await admin.api('GET', '/api/admin/timetable?day= someday ')).status, 400);
});

test('50. sensitive fields not exposed; timezone values untouched', async () => {
  const checks = [
    await admin.api('GET', '/api/admin/timetable'),
    await cr1.api('GET', '/api/cr/timetable'),
    await student1.api('GET', '/api/student/timetable'),
  ];
  for (const r of checks) {
    assert.ok(!/\$2[aby]\$/.test(r.text), 'no hash');
    assert.ok(!r.text.includes('activationToken') && !r.text.includes('resetToken') && !r.text.includes('codeHash'));
    assert.ok(!r.text.includes('api_key') && !r.text.includes('api_secret'));
    for (const t of r.json.data) {
      assert.equal(typeof t.startTime, 'string'); // recurring wall-clock, never UTC
      assert.match(t.startTime, /^([01]\d|2[0-3]):[0-5]\d$/);
    }
  }
});

test('51. audit events generated safely', async () => {
  for (const action of ['timetable.create', 'timetable.update', 'timetable.archive']) {
    assert.ok(await AuditLog.countDocuments({ action }) > 0, `${action} recorded`);
  }
  const logs = await AuditLog.find({ action: /^timetable\./ });
  const text = JSON.stringify(logs.map((l) => ({ b: l.before, a: l.after })));
  assert.ok(!text.includes('password') && !text.includes('CrPass'));
});

/* ==================== CONCURRENCY + REGRESSION (52–58) ==================== */
test('52. concurrent identical creates resolve to ONE entry', async () => {
  // two racing creates for the same section/day slot — the Section-doc write
  // inside the transaction serializes them; the loser retries, sees the
  // winner's entry, and gets a controlled 409.
  const attempts = await Promise.allSettled([
    cr1.api('POST', '/api/cr/timetable', { subject: subA1, day: 'saturday', startTime: '11:00', endTime: '12:00' }),
    cr1.api('POST', '/api/cr/timetable', { subject: subA1, day: 'saturday', startTime: '11:00', endTime: '12:00' }),
  ]);
  const statuses = attempts.map((a) => a.value.status);
  assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one wins: ${statuses}`);
  assert.equal(statuses.filter((s) => s === 409).length, 1, `one controlled 409: ${statuses}`);
  assert.equal(await Timetable.countDocuments({
    section: secA, day: 'saturday', startTime: '11:00', status: 'active',
  }), 1);
});

test('52b. exact duplicate after direct insert also rejected (sequential path)', async () => {
  const res = await cr1.api('POST', '/api/cr/timetable', {
    subject: subA1, day: 'saturday', startTime: '11:00', endTime: '12:00',
  });
  assert.equal(res.status, 409); // existing (from race test) blocks
});

test('53–58. regression guard: earlier phases healthy', async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.database, 'connected');
  assert.equal((await admin.api('GET', '/api/admin/subjects')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/announcements')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/notes')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/assignments')).status, 200);
  assert.equal((await admin.api('GET', '/api/admin/assignments?sectionId=bad')).status, 400);
  assert.equal((await cr1.api('GET', '/api/cr/subjects')).status, 200);
  assert.equal((await student1.api('GET', '/api/student/notes')).status, 200);
  assert.equal((await student1.api('GET', '/api/student/assignments')).status, 200);
  const bad = await cr1.api('POST', '/api/auth/login', { email: 'cr1@test.local', password: 'Wrong1!' });
  assert.equal(bad.status, 401);
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
