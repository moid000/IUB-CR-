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
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-03', startTime: '10:00', endTime: '11:00', room: 'Room 12' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  created = r.json.data._id;
  assert.equal(r.json.data.teacherConfirmation.code, undefined);
  assert.equal(r.json.data.teacherConfirmation.status, 'awaiting');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, teacher.whatsapp);
  assert.equal(sent[0].body.split('\n')[0], '*Tri3M Class Agent*');
  assert.match(sent[0].body, /AI-Powered Class Management Assistant/);
  assert.match(sent[0].body, /Assalam-o-Alaikum Respected \*Dr Test\*/,);
  assert.match(sent[0].body, /I am \*Alex Representative\*, CR of \*4B\*\./);
  assert.match(sent[0].body, /🎓 Department: \*Computer Science\*/);
  assert.match(sent[0].body, /📚 Semester: \*4\*/);
  assert.match(sent[0].body, /🏫 Section: \*4B\*/);
  assert.match(sent[0].body, /Your \*Data Structures\* lecture is scheduled on Sat:/);
  assert.match(sent[0].body, /📍 Room 12/);
  assert.match(sent[0].body, /Please reply \*YES\* or \*NO\*\./);
  assert.match(sent[0].body, /— Tri3M Class Agent\nDeveloped by the students of the AI Department, IUB\nSemester 2 • Section 3M/);
  assert.doesNotMatch(sent[0].body.split('\n')[0], /AI Dept|Section 3M/);
  const code = (await Timetable.findById(created)).teacherConfirmation.code;
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
  // Every YES/NO answer now triggers a varied thank-you with the portal link.
  assert.equal(sent[1].to, teacher.whatsapp);
  assert.match(sent[1].body, /iubcr\.vercel\.app/);
  assert.match(sent[1].body, /\*Dr Test\*/);
  assert.match(sent[1].body, /confirmed/i);
  assert.match(sent[1].body, /— Tri3M Class Agent/);
});

test('material reschedule sends a new ref; old reply is rejected, new NO marks unavailable', async () => {
  const before = (await Timetable.findById(created)).teacherConfirmation.code;
  const r = await cr('PATCH', `/api/cr/timetable/${created}`, { startTime: '12:00', endTime: '13:00' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.teacherConfirmation.code, undefined);
  const current = (await Timetable.findById(created)).teacherConfirmation.code;
  assert.notEqual(current, before);
  assert.equal(sent.length, 3); // create + YES thank-you + rescheduled ref
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
  assert.equal(sent.length, 5); // create + YES thanks + rescheduled ref + NO thanks + copy
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

test('two pending classes queue one-by-one so a plain YES/NO stays unambiguous', async () => {
  const a = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-07', startTime: '10:00', endTime: '11:00' });
  const sentAfterA = sent.length;
  const b = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-08', startTime: '10:00', endTime: '11:00' });
  // Second class waits behind the first: no second message, no ambiguity.
  assert.equal(sent.length, sentAfterA);
  assert.equal((await Timetable.findById(a.json.data._id)).teacherConfirmation.status, 'awaiting');
  assert.equal((await Timetable.findById(b.json.data._id)).teacherConfirmation.status, 'queued');
  // Teacher answers the ONE question they were asked: plain YES is enough.
  assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
  assert.equal((await Timetable.findById(a.json.data._id)).teacherConfirmation.status, 'confirmed');
  // The answer freed the queue: the second class question went out immediately.
  assert.equal((await Timetable.findById(b.json.data._id)).teacherConfirmation.status, 'awaiting');
  // A plain NO then decides the second class on its own.
  assert.equal((await webhook(incoming('NO'))).json.data.updated, true);
  assert.equal((await Timetable.findById(b.json.data._id)).teacherConfirmation.status, 'declined');
});

test('an old reply-time cannot confirm a newer request; millisecond timestamps still work', async () => {
  const c = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-09', startTime: '10:00', endTime: '11:00' });
  const stale = incoming('YES');
  stale.data.time = Math.floor(new Date((await Timetable.findById(c.json.data._id)).teacherConfirmation.sentAt).getTime() / 1000) - 120;
  assert.equal((await webhook(stale)).json.data.updated, false);
  assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
  assert.equal((await Timetable.findById(c.json.data._id)).teacherConfirmation.status, 'confirmed');
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
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-11', startTime: '10:00', endTime: '11:00' });
  assert.equal(r.status, 200);
  assert.equal(sent.length, count);
  assert.equal((await Timetable.findById(r.json.data._id)).teacherConfirmation.status, 'none');
  const copied = await Timetable.findOne({ section, date: '2099-01-04' });
  await cr('POST', `/api/cr/timetable/${copied._id}/archive`);
  assert.equal((await webhook(incoming(`YES ${copied.teacherConfirmation.code}`))).json.data.updated, false);
});

test('thank-you follow-ups rotate through a pool and always carry the portal link', async () => {
  const { buildFollowUpMessage } = await import('../backend/services/teacherConfirmationService.js');
  const ctx = { teacher: 'Dr Test', subject: 'Data Structures', section: '4B', day: 'Sun, 3 Jan 2099', time: '10:00 AM – 11:00 AM' };
  const yes = new Set(Array.from({ length: 40 }, () => buildFollowUpMessage('yes', ctx)));
  const no = new Set(Array.from({ length: 40 }, () => buildFollowUpMessage('no', ctx)));
  assert.ok(yes.size >= 3, `YES pool should rotate across variants (got ${yes.size})`);
  assert.ok(no.size >= 3, `NO pool should rotate across variants (got ${no.size})`);
  for (const body of [...yes, ...no]) {
    assert.match(body, /iubcr\.vercel\.app/);
    assert.match(body, /Tri3M Class Agent/);
    assert.match(body, /\*Dr Test\*/);
    assert.match(body, /\*Data Structures\*/);
  }
  for (const body of yes) assert.match(body, /confirmed/i);
  for (const body of no) assert.match(body, /not confirmed|not left waiting/);
});

test.after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongod.stop();
});
