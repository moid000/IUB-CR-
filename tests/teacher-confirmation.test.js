import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('teacher_confirmation_test');
process.env.JWT_SECRET = 'test-teacher-confirmation-jwt';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'owner@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.ULTRAMSG_INSTANCE_ID = 'test-instance';
process.env.ULTRAMSG_TOKEN = 'fake-token';
process.env.ULTRAMSG_WEBHOOK_SECRET = 'fake-webhook-secret';
process.env.DEADLINE_SWEEP_SECRET = 'fake-sweep-secret';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { Timetable, Teacher, Section, Subject, User } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
const realFetch = globalThis.fetch;
const sent = [];
let failNext = false;
globalThis.fetch = (url, options) => {
  if (String(url).startsWith('https://api.ultramsg.com/test-instance/messages/chat')) {
    const data = new URLSearchParams(options.body);
    sent.push({ to: data.get('to'), body: data.get('body') });
    if (failNext) { failNext = false; return Promise.resolve(new Response(JSON.stringify({ error: 'gateway unavailable' }), { status: 502 })); }
    return Promise.resolve(new Response(JSON.stringify({ sent: true, id: `msg-${sent.length}` }), { status: 200 }));
  }
  return realFetch(url, options);
};
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const session = () => {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, { method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json() };
  };
};
const admin = session();
const cr = session();
const student = session();
const webhook = (body, key = 'fake-webhook-secret') => admin('POST', `/api/whatsapp/teacher-reply?key=${key}`, body);
const incoming = (text, from = '923001112233@c.us') => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id: `incoming-${Math.random()}`, from, body: text, fromMe: false, type: 'chat', time: Math.floor(Date.now() / 1000) } });

let section, subject, teacher, created;
test('fixture: CR, student, section and linked teacher', async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const academicSession = (await admin('POST', '/api/admin/sessions', { name: '2099–2100' })).json.data._id;
  section = (await admin('POST', '/api/admin/sections', { department: dept, session: academicSession, semester: 4, name: '4B' })).json.data._id;
  subject = (await admin('POST', '/api/admin/subjects', { section, name: 'Data Structures', code: 'DS-101' })).json.data._id;
  const hash = await bcrypt.hash('TeacherTest123!', 10);
  const crDoc = await User.create({ name: 'Alex Representative', email: 'cr-teacher@test.local', phone: '+923009876543', role: 'cr', section,
    registrationStatus: 'active', emailVerified: true, password: hash });
  await Section.updateOne({ _id: section }, { $set: { cr: crDoc._id } });
  await User.create({ name: 'Learner', email: 'student-teacher@test.local', phone: '+923009876544', role: 'student', section,
    registrationStatus: 'active', emailVerified: true, password: hash, rollNo: 'S-001' });
  assert.equal((await cr('POST', '/api/auth/login', { email: 'cr-teacher@test.local', password: 'TeacherTest123!' })).status, 200);
  assert.equal((await student('POST', '/api/auth/login', { email: 'student-teacher@test.local', password: 'TeacherTest123!' })).status, 200);
  teacher = await Teacher.create({ name: 'Dr Test', subject, section, whatsapp: '923001112233', createdBy: crDoc._id });
});

test('create sends one concise dynamic-class message and exposes pending status on both portals', async () => {
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-03', startTime: '10:00', endTime: '11:00' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  created = r.json.data._id;
  assert.equal(r.json.data.teacherConfirmation.code, undefined);
  assert.equal(r.json.data.teacherConfirmation.status, 'awaiting');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, teacher.whatsapp);
  assert.match(sent[0].body, /Computer Science · Semester 4 · Section 4B/);
  assert.match(sent[0].body, /Data Structures.*Alex Representative \(CR\)/);
  assert.match(sent[0].body, /Tri3M Class Agent.*Developed by the students of AI Dept, Semester 2, Section 3M/);
  assert.doesNotMatch(sent[0].body.split('\n')[0], /AI Dept|Section 3M/);
  const code = (await Timetable.findById(created)).teacherConfirmation.code;
  assert.match(sent[0].body, /Reply \*YES\* or \*NO\*\./);
  assert.doesNotMatch(sent[0].body, new RegExp(code)); // reference code stays private, never printed in the message
  assert.match(sent[0].body, /\n\n/); // blank-line spacing between sections for readability
  const crList = await cr('GET', '/api/cr/timetable?date=2099-01-03&status=active');
  const studentList = await student('GET', '/api/student/timetable?date=2099-01-03&status=active');
  assert.equal(crList.json.data[0].teacherConfirmation.status, 'awaiting');
  assert.equal(studentList.json.data[0].teacherConfirmation.status, 'awaiting');
  assert.equal(studentList.json.data[0].teacherConfirmation.code, undefined); // private ref hidden from public API
  const single = await student('GET', `/api/student/timetable/${created}`);
  assert.equal(single.json.data.teacherConfirmation.code, undefined);
  assert.equal(single.json.data.teacherConfirmation.phone, undefined);
});

test('invalid secret, wrong number and unrelated data never change status', async () => {
  const code = (await Timetable.findById(created)).teacherConfirmation.code;
  assert.equal((await webhook(incoming(`YES ${code}`), 'wrong')).status, 401);
  assert.equal((await webhook(incoming(`YES ${code}`, '923001112234@c.us'))).json.data.updated, false);
  assert.equal((await webhook(incoming('YES', '923001112234@c.us'))).json.data.updated, false);
  assert.equal((await webhook({ ...incoming(`YES ${code}`), instanceId: 'different' })).json.data.updated, false);
  assert.equal((await Timetable.findById(created)).teacherConfirmation.status, 'awaiting');
});

test('matching teacher YES confirms exactly one slot; duplicate and wrong reply ignored', async () => {
  const code = (await Timetable.findById(created)).teacherConfirmation.code;
  assert.equal((await webhook(incoming(`YES ${code}`))).json.data.updated, true);
  assert.equal((await webhook(incoming(`NO ${code}`))).json.data.updated, false);
  assert.equal((await student('GET', '/api/student/timetable?date=2099-01-03&status=active')).json.data[0].teacherConfirmation.status, 'confirmed');
});

test('material reschedule sends a new ref; old reply is rejected, new NO marks unavailable', async () => {
  const before = (await Timetable.findById(created)).teacherConfirmation.code;
  const r = await cr('PATCH', `/api/cr/timetable/${created}`, { startTime: '12:00', endTime: '13:00' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.teacherConfirmation.code, undefined);
  const current = (await Timetable.findById(created)).teacherConfirmation.code;
  assert.notEqual(current, before);
  assert.equal(sent.length, 2);
  assert.equal((await webhook(incoming(`YES ${before}`))).json.data.updated, false);
  assert.equal((await webhook(incoming(`NO ${current}`))).json.data.updated, true);
  assert.equal((await Timetable.findById(created)).teacherConfirmation.status, 'declined');
  const count = sent.length;
  assert.equal((await cr('PATCH', `/api/cr/timetable/${created}`, { startTime: '12:00', endTime: '13:00' })).status, 200);
  assert.equal(sent.length, count); // identical save never bothers the teacher
});

test('copy gets its OWN independent reference, old slot response cannot affect copy', async () => {
  const r = await cr('POST', '/api/cr/timetable/copy', { fromDate: '2099-01-03', toDate: '2099-01-04' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.copied, 1);
  assert.equal(sent.length, 3);
  const copied = await Timetable.findOne({ section, date: '2099-01-04' });
  const original = await Timetable.findById(created);
  assert.notEqual(copied.teacherConfirmation.code, original.teacherConfirmation.code);
  assert.equal(copied.teacherConfirmation.status, 'awaiting');
});

test('a single awaiting request accepts natural YES or NO from its teacher', async () => {
  const yesSlot = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-06', startTime: '10:00', endTime: '11:00' });
  // Copied 2099-01-04 is still awaiting from a previous test: close it first.
  const oldPending = await Timetable.findOne({ section, date: '2099-01-04' });
  assert.equal((await webhook(incoming(`YES ${oldPending.teacherConfirmation.code}`))).json.data.updated, true);
  assert.equal((await webhook(incoming('Yes'))).json.data.updated, true);
  assert.equal((await Timetable.findById(yesSlot.json.data._id)).teacherConfirmation.status, 'confirmed');
  const noSlot = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-06', startTime: '12:00', endTime: '13:00' });
  assert.equal((await webhook(incoming('NO'))).json.data.updated, true);
  assert.equal((await Timetable.findById(noSlot.json.data._id)).teacherConfirmation.status, 'declined');
});

test('bare reply cannot guess between two classes or confirm a newer request from an old event', async () => {
  const a = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-07', startTime: '10:00', endTime: '11:00' });
  const b = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-08', startTime: '10:00', endTime: '11:00' });
  assert.equal((await webhook(incoming('YES'))).json.data.updated, false);
  assert.equal((await Timetable.findById(a.json.data._id)).teacherConfirmation.status, 'awaiting');
  assert.equal((await Timetable.findById(b.json.data._id)).teacherConfirmation.status, 'awaiting');
  const one = await Timetable.findById(a.json.data._id);
  assert.equal((await webhook(incoming(`YES ${one.teacherConfirmation.code}`))).json.data.updated, true);
  const stale = incoming('YES');
  stale.data.time = Math.floor(new Date((await Timetable.findById(b.json.data._id)).teacherConfirmation.sentAt).getTime() / 1000) - 120;
  assert.equal((await webhook(stale)).json.data.updated, false);
  assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
  assert.equal((await Timetable.findById(b.json.data._id)).teacherConfirmation.status, 'confirmed');
  const millisecondsSlot = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-10', startTime: '10:00', endTime: '11:00' });
  const millis = incoming('YES');
  delete millis.data.time;
  millis.data.timestamp = Date.now(); // provider chat-history format
  assert.equal((await webhook(millis)).json.data.updated, true);
  assert.equal((await Timetable.findById(millisecondsSlot.json.data._id)).teacherConfirmation.status, 'confirmed');
});

test('gateway failure never cancels creation; existing external sweep safely retries it', async () => {
  failNext = true;
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-05', startTime: '10:00', endTime: '11:00' });
  assert.equal(r.status, 200);
  const slot = await Timetable.findById(r.json.data._id);
  assert.equal(slot.teacherConfirmation.status, 'failed');
  await Timetable.updateOne({ _id: slot._id }, { $set: { 'teacherConfirmation.nextAttemptAt': new Date(0) } });
  const sweep = await admin('GET', '/api/whatsapp/deadline-sweep?secret=fake-sweep-secret');
  assert.equal(sweep.status, 200, JSON.stringify(sweep.json));
  assert.equal(sweep.json.data.teacherConfirmations.processed, 1);
  assert.equal((await Timetable.findById(slot._id)).teacherConfirmation.status, 'awaiting');
});

test('unlinking a teacher invalidates their already-sent pending answer', async () => {
  const slot = await Timetable.findOne({ section, date: '2099-01-04' });
  await Teacher.updateOne({ _id: teacher._id }, { $set: { whatsapp: '923009999999' } });
  assert.equal((await webhook(incoming(`YES ${slot.teacherConfirmation.code}`))).json.data.updated, false);
  await Teacher.updateOne({ _id: teacher._id }, { $set: { whatsapp: '923001112233' } });
});

test('past class backfills do not disturb teachers', async () => {
  const count = sent.length;
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2020-01-05', startTime: '10:00', endTime: '11:00' });
  assert.equal(r.status, 200);
  assert.equal(sent.length, count);
  assert.equal(r.json.data.teacherConfirmation.status, 'none');
});

test('unknown subject teacher means no message, and archived slot ignores a late answer', async () => {
  await Teacher.deleteOne({ _id: teacher._id });
  const count = sent.length;
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-09', startTime: '10:00', endTime: '11:00' });
  assert.equal(r.status, 200);
  assert.equal(sent.length, count);
  assert.equal((await Timetable.findById(r.json.data._id)).teacherConfirmation.status, 'none');
  const copied = await Timetable.findOne({ section, date: '2099-01-04' });
  await cr('POST', `/api/cr/timetable/${copied._id}/archive`);
  assert.equal((await webhook(incoming(`YES ${copied.teacherConfirmation.code}`))).json.data.updated, false);
});

test.after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongod.stop();
});
