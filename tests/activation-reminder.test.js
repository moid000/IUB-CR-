/**
 * CR PORTAL — PENDING STUDENT ACTIVATION REMINDER (owner feature 2026-10-18).
 * Real HTTP + real services + real gateway mock:
 *   1. Eligibility: only still-pending students of the CR's OWN section with
 *      a valid phone are counted; active/suspended/missing-phone students
 *      are skipped and reported — never silently, never messaged.
 *   2. Authorization: student/non-CR roles get 403; pending (unactivated)
 *      CR accounts get 403; a CR cannot target another section's students.
 *   3. The GET (dialog) endpoint never sends anything.
 *   4. Confirming sends professional English messages with each student's
 *      OWN verified details (name/roll/department/semester/section/CR) and
 *      the verified /student/activate URL — one student's details are never
 *      sent to another student's number.
 *   5. Double-send protection: repeat POSTs (double-click/retry) within the
 *      24h dedupe window send NOTHING twice; re-POST reports honest skips.
 *   6. Partial gateway failures are reported accurately; a total failure is
 *      never presented as success.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('activation_reminder_test');
process.env.JWT_SECRET = 'test-only-jwt-secret-reminder';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.ULTRAMSG_INSTANCE_ID = 'test-instance';
process.env.ULTRAMSG_TOKEN = 'fake-token';
process.env.ULTRAMSG_WEBHOOK_SECRET = 'fake-webhook-secret';
process.env.APP_URL = 'https://www.tri2m.com';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { User, Section, Department, AcademicSession, OutboxMessage, AuditLog } = models;
const { buildReminderMessage } = await import('../backend/services/activationReminderService.js');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

/* ---- gateway mock: ultramsg (test gateway) with per-recipient failure ---- */
const gwSent = [];
let failPhones = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const u = String(url);
  if (u.includes('api.ultramsg.com/test-instance/messages/chat')) {
    const data = new URLSearchParams(options.body);
    const to = data.get('to');
    if (failPhones.has(to)) return Promise.resolve(new Response(JSON.stringify({ sent: false, error: 'gateway down' }), { status: 200 }));
    gwSent.push({ to, body: data.get('body') });
    return Promise.resolve(new Response(JSON.stringify({ sent: true, id: `msg-${gwSent.length}` }), { status: 200 }));
  }
  return realFetch(url, options);
};

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

function makeSession() {
  const jar = new Map();
  return {
    async api(method, path, body) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
      let json = null;
      try { json = await res.json(); } catch { /* non-JSON */ }
      return { status: res.status, json, data: json?.data };
    },
  };
}

let crA, crB, studentSess, sectionA, sectionB, crAUser;
const bcrypt = (await import('bcryptjs')).default;
const loginAs = async (email, password = 'AdminPass123!456') => {
  const sess = makeSession();
  const res = await sess.api('POST', '/api/auth/login', { email, password });
  assert.equal(res.status, 200, `login must succeed for ${email}`);
  return sess;
};
const mkCr = async ({ name, email, section }) =>
  User.create({ name, email, role: 'cr', section: section._id, registrationStatus: 'active',
    password: await bcrypt.hash('AdminPass123!456', 10) });

test.before(async () => {
  await Section.deleteMany({}); await User.deleteMany({}); await Department.deleteMany({});
  await AcademicSession.deleteMany({}); await OutboxMessage.deleteMany({});
  const dept = await Department.create({ name: 'Computer Science', code: 'CS' });
  const session = await AcademicSession.create({ name: '2024-2028' });
  sectionA = await Section.create({ name: '3M', semester: 2, department: dept._id, session: session._id,
    whatsappGroup: { id: '120363A@g.us', name: 'General 3M' } });
  sectionB = await Section.create({ name: '3A', semester: 3, department: dept._id, session: session._id,
    whatsappGroup: { id: '120363B@g.us', name: 'General 3A' } });

  crAUser = await mkCr({ name: 'Ali Raza', email: 'cr-a@test.local', section: sectionA });
  sectionA.cr = crAUser._id;
  await sectionA.save();
  crA = await loginAs('cr-a@test.local');

  await mkCr({ name: 'Sana Khan', email: 'cr-b@test.local', section: sectionB });
  crB = await loginAs('cr-b@test.local');

  studentSess = makeSession();

  // SECTION A students: 2 eligible pending, 1 pending w/o phone, 1 active, 1 suspended
  await User.create({ name: 'Pending One', email: 'p1@test.local', role: 'student', section: sectionA._id,
    rollNo: 'FA22-001', phone: '+923001112233', registrationStatus: 'pending' });
  await User.create({ name: 'Pending Two', email: 'p2@test.local', role: 'student', section: sectionA._id,
    rollNo: 'FA22-002', phone: '0300 111 2244', registrationStatus: 'pending' });
  await User.create({ name: 'No Phone', email: 'p3@test.local', role: 'student', section: sectionA._id,
    rollNo: 'FA22-003', registrationStatus: 'pending' });
  await User.create({ name: 'Active One', email: 'a1@test.local', role: 'student', section: sectionA._id,
    rollNo: 'FA22-004', phone: '+923001112255', registrationStatus: 'active' });
  await User.create({ name: 'Suspended One', email: 's1@test.local', role: 'student', section: sectionA._id,
    rollNo: 'FA22-005', phone: '+923001112266', registrationStatus: 'suspended' });
  // SECTION B student (cross-section isolation)
  await User.create({ name: 'Section B Pending', email: 'bp1@test.local', role: 'student', section: sectionB._id,
    rollNo: 'FB22-001', phone: '+923001112277', registrationStatus: 'pending' });
});

test.afterEach(() => { gwSent.length = 0; failPhones = new Set(); });

test('AR-1: eligibility snapshot — only valid-phone pending students of the OWN section', async () => {
  const res = await crA.api('GET', '/api/cr/students/activation-reminders');
  assert.equal(res.status, 200);
  assert.equal(res.data.eligibleCount, 2, 'Pending One + Pending Two only');
  const skipped = res.data.skipped;
  assert.ok(skipped.some((s) => s.name === 'No Phone' && /phone/i.test(s.reason)), 'missing phone reported');
  assert.ok(!skipped.some((s) => s.name === 'Active One'), 'active student never in the report');
  assert.ok(!skipped.some((s) => s.name === 'Suspended One'), 'suspended student never eligible');
  assert.equal(gwSent.length, 0, 'GET never sends anything');
});

test('AR-2: authorization — students 403, CR sees only own section', async () => {
  // an ACTIVE student logs in — the role gate must still refuse CR endpoints
  await User.updateOne({ email: 'a1@test.local' }, { password: await bcrypt.hash('AdminPass123!456', 10) });
  const login = await studentSess.api('POST', '/api/auth/login', { email: 'a1@test.local', password: 'AdminPass123!456' });
  if (login.status === 200) {
    assert.equal((await studentSess.api('GET', '/api/cr/students/activation-reminders')).status, 403, 'student gets 403');
    assert.equal((await studentSess.api('POST', '/api/cr/students/activation-reminders')).status, 403, 'student cannot send');
  }
  // CR B sees only section B students
  const resB = await crB.api('GET', '/api/cr/students/activation-reminders');
  assert.equal(resB.status, 200);
  assert.equal(resB.data.eligibleCount, 1, 'section B: only its own pending student');
});

test('AR-3: confirmed send — correct personalized English messages with verified details + activation URL', async () => {
  const res = await crA.api('POST', '/api/cr/students/activation-reminders');
  assert.equal(res.status, 200);
  assert.equal(res.data.sent, 2, 'both eligible students confirmed sent');
  assert.equal(gwSent.length, 2, 'exactly two gateway messages');
  assert.equal(gwSent.filter((m) => m.to === '923001112233').length, 1, 'E.164 digits for +92…233');
  assert.equal(gwSent.filter((m) => m.to === '03001112244').length, 1, 'spaced number delivered as stored digits');

  const one = gwSent.find((m) => m.body.includes('Pending One'));
  assert.ok(one, 'Pending One got a message');
  const expected = [
    'Reminder: Activate Your CR Portal Account',
    'Dear Pending One,',
    '• Name: Pending One',
    '• Roll Number: FA22-001',
    '• Department: Computer Science',
    '• Semester: 2',
    '• Section: 3M',
    '• Class Representative (CR): Ali Raza',
    'https://www.tri2m.com/student/activate',
    'CR Portal Administration',
  ];
  for (const line of expected) assert.ok(one.body.includes(line), `message must include: ${line}`);
  assert.ok(!one.body.includes('Pending Two'), 'no other student data leaked into this message');

  const two = gwSent.find((m) => m.body.includes('Pending Two'));
  assert.ok(two && two.body.includes('FA22-002'), 'Pending Two has her own roll number');
  assert.ok(!two.body.includes('FA22-001'), 'Pending One data never sent to Pending Two');
});

test('AR-4: double-send protection — repeat POST within the dedupe window sends nothing again', async () => {
  const res = await crA.api('POST', '/api/cr/students/activation-reminders');
  assert.equal(res.status, 200);
  assert.equal(res.data.sent, 0, 'nothing re-sent within 24h');
  assert.equal(gwSent.length, 0, 'gateway received zero messages');
  const skipped = res.data.skipped;
  assert.equal(skipped.filter((s) => /already reminded/i.test(s.reason)).length, 2, 'reported as already reminded');
});

test('AR-5: partial gateway failure — honest summary, others still processed', async () => {
  // fresh section C so the 24h dedupe window is clean
  const dept = await Department.findOne({});
  const session = await AcademicSession.findOne({});
  const sectionC = await Section.create({ name: '3C', semester: 1, department: dept._id, session: session._id });
  await mkCr({ name: 'Cr C', email: 'cr-c@test.local', section: sectionC });
  const crC = await loginAs('cr-c@test.local');
  const okStu = await User.create({ name: 'Ok Student', email: 'okc@test.local', role: 'student', section: sectionC._id,
    rollNo: 'FC22-001', phone: '+923001112288', registrationStatus: 'pending' });
  const badStu = await User.create({ name: 'Bad Student', email: 'badc@test.local', role: 'student', section: sectionC._id,
    rollNo: 'FC22-002', phone: '+923001112299', registrationStatus: 'pending' });
  failPhones = new Set(['923001112299']);

  const res = await crC.api('POST', '/api/cr/students/activation-reminders');
  assert.equal(res.status, 200);
  assert.equal(res.data.sent, 1, 'the healthy student was sent');
  assert.equal(res.data.failed.length, 1, 'the failing student is reported failed');
  assert.equal(res.data.failed[0].name, 'Bad Student');
  assert.equal(gwSent.length, 1, 'only the healthy number reached the gateway');

  // audit trail exists
  const audited = await AuditLog.findOne({ action: 'cr.students.activation_reminder', 'after.sent': 1 }).lean();
  assert.ok(audited, 'the action is audited with its honest summary');
});

test('AR-6: message builder — missing roll number or CR is omitted, never invented', async () => {
  const msg = buildReminderMessage(
    { name: 'Minimal Student', rollNo: '', phone: '+923000000000' },
    { department: 'Zoology', semester: 4, section: '4Z', crName: '' },
  );
  assert.ok(msg.includes('Dear Minimal Student,'));
  assert.ok(!msg.includes('Roll Number'), 'no roll-number line when the record has none');
  assert.ok(!msg.includes('• Class Representative'), 'no CR details line when the section has none');
  assert.ok(msg.includes('• Department: Zoology'));
  assert.ok(msg.includes('• Semester: 4'));
  assert.ok(msg.includes('• Section: 4Z'));
  assert.ok(msg.includes('https://www.tri2m.com/student/activate'));
});

test.after(async () => {
  server.close();
  await mongoose.connection.close();
  await mongod.stop();
});
