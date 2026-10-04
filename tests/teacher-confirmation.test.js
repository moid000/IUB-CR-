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
process.env.GOOGLE_API_KEY = 'test-key';
process.env.ALLOW_TEST_GEMINI = '1'; // teacher-interpretation tests mock the Gemini fetch

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { Timetable, Teacher, Section, Subject, User } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
const realFetch = globalThis.fetch;
const sent = [];
let failNext = false;
let geminiAnswer = null; // 'YES' | 'NO' | 'UNCLEAR' | null (null = API error → rules fallback)
globalThis.fetch = (url, options) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    if (geminiAnswer) {
      const payload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: geminiAnswer }) }] } }] };
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 400 })); // API down → rules fallback
  }
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

test('unrecognized replies get a polite only-YES-or-NO hint; the question stays open and confirmable', async () => {
  // clean slate: earlier tests deleted the Teacher doc and left an awaiting
  // slot whose teacher ref dangles — close it directly and restore the teacher.
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const crDoc = await User.findOne({ email: 'cr-teacher@test.local' });
  await Teacher.create({ name: 'Dr Test', subject, section, whatsapp: '923001112233', createdBy: crDoc._id });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-12', startTime: '09:00', endTime: '10:00', room: 'Room 9' });
  const slotId = r.json.data._id;
  const code = (await Timetable.findById(slotId)).teacherConfirmation.code;
  const sentBefore = sent.length;
  const before = (await Timetable.findById(slotId)).teacherConfirmation;

  // "acha, dekh ke bataon ga" — genuinely unclear, not a bare YES/NO
  const hint = await webhook(incoming('acha, dekh ke bataon ga'));
  assert.equal(hint.json.data.updated, true); // handled — the teacher is no longer left in silence
  assert.equal(sent.length, sentBefore + 1);
  assert.equal(sent.at(-1).to, teacher.whatsapp);
  assert.match(sent.at(-1).body, /I'm an (AI|automated) (agent|assistant)/);
  assert.match(sent.at(-1).body, /plain \*YES\* or \*NO\*/);
  assert.match(sent.at(-1).body, /Assalam-o-Alaikum Respected \*Dr Test\*/);
  assert.match(sent.at(-1).body, /— Tri3M Class Agent\nDeveloped by the students of the AI Department, IUB/);
  const after = (await Timetable.findById(slotId)).teacherConfirmation;
  assert.equal(after.status, 'awaiting'); // a hint never answers the question
  assert.equal(after.attempts, before.attempts); // and never consumes a retry

  // an immediate second unclear reply is throttled — no hint spam
  assert.equal((await webhook(incoming('pata nahi abhi, baad me bataon ga'))).json.data.updated, false);
  assert.equal(sent.length, sentBefore + 1);

  // the teacher can still answer normally right after the hint
  assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');

  // once the question is resolved, further chatter gets no auto-reply
  assert.equal((await webhook(incoming('ok theek ha'))).json.data.updated, false);
  assert.equal(sent.length, sentBefore + 2); // only the thank-you follow-up was added
});

test('unrecognized replies from strangers or group numbers never trigger a hint', async () => {
  const sentBefore = sent.length;
  assert.equal((await webhook(incoming('yes betha ma aaon ga', '923009990011@c.us'))).json.data.updated, false);
  assert.equal((await webhook(incoming('hello', '120363abc@g.us'))).json.data.updated, false);
  assert.equal(sent.length, sentBefore); // nothing sent to anyone
});

test('OWNER FEATURE: interpretReply — natural-language YES/NO in Roman Urdu, English and mixed', async () => {
  const { interpretReply } = await import('../backend/services/teacherConfirmationService.js');
  // YES in the wild
  for (const yes of ['g beta kl class ho gi time p ho gi', 'yes betha ma aaon ga', 'G bilkul ho gi sir',
    'inshallah aaon ga', 'ok', 'no problem, ho gi', 'ji zaroor aaonga', 'theek hai chalega']) {
    assert.equal(interpretReply(yes), 'YES', `expected YES: ${yes}`);
  }
  // NO in the wild — OWNER BUG CASE (2026-10-04): 'mera dil ni ha' was wrongly
  // confirmed as YES ('ni' missing from negation, 'ha' falsely read as haan)
  for (const no of ['mera dil ni ha', 'mera dil nahi hai class ka', 'mujy maan ni ha class ki',
    'mood nahi hai', 'ma a ni aa sakta', 'nahi ho gi, urgent kaam hai', 'cancel kar do aj ki',
    'g nahi bhai, chutti hai', 'busy hoon aa nahi sakta']) {
    assert.equal(interpretReply(no), 'NO', `expected NO: ${no}`);
  }
  // YES still solid after the fix — weak words ('ha' as bare hai, 'ya' = or) removed
  for (const yes of ['ha beta ho gi', 'haan zaroor aaon ga']) {
    assert.equal(interpretReply(yes), 'YES', `expected YES: ${yes}`);
  }
  // genuinely unclear — never guessed, hint path instead
  for (const unclear of ['pata nahi abhi', 'acha, dekh ke bataon ga', 'acha', 'maybe', 'thori der me bataon ga']) {
    assert.equal(interpretReply(unclear), null, `expected UNCLEAR: ${unclear}`);
  }
});

test('OWNER FEATURE: "g beta class ho gi" is INTERPRETED as YES — class confirmed, English ack sent', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-13', startTime: '09:00', endTime: '10:00', room: 'Room 10' });
  const slotId = r.json.data._id;
  const sentBefore = sent.length;

  const res = await webhook(incoming('g beta kl class ho gi time pe'));
  assert.equal(res.json.data.updated, true);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');

  // ENGLISH acknowledgement that states what was understood (owner rule)
  const ack = sent.at(-1);
  assert.equal(ack.to, teacher.whatsapp);
  assert.match(ack.body, /understood your reply as a \*YES\*|reads as a confirmation/i);
  assert.match(ack.body, /\*confirmed\*/i);
  assert.match(ack.body, /iubcr\.vercel\.app/);
  assert.match(ack.body, /Tri3M Class Agent/);
  assert.equal(sent.length, sentBefore + 1); // no hint spam — interpretation replaced it

  // resolved: later chatter gets no auto-reply
  assert.equal((await webhook(incoming('acha theek hai'))).json.data.updated, false);
});

test('OWNER FEATURE: a natural-language NO is INTERPRETED — class declined, English ack sent', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-14', startTime: '09:00', endTime: '10:00', room: 'Room 11' });
  const slotId = r.json.data._id;

  assert.equal((await webhook(incoming('nahi bhai, kal leave hai'))).json.data.updated, true);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'declined');

  const ack = sent.at(-1);
  assert.match(ack.body, /understood your reply as a \*NO\*|reads as a cancellation/i);
  assert.match(ack.body, /\*cancelled\*/i);
  assert.match(ack.body, /Tri3M Class Agent/);
});

test('OWNER RULE: GEMINI FIRST — any reply is understood by meaning, not a word list', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-15', startTime: '09:00', endTime: '10:00', room: 'Room 12' });
  const slotId = r.json.data._id;

  // 'ma thak gaya hoon aaj' matches NO fixed word — only meaning (tired → not coming)
  geminiAnswer = 'NO';
  try {
    assert.equal((await webhook(incoming('ma thak gaya hoon aaj, you take care'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'declined');
    assert.match(sent.at(-1).body, /understood your reply as a \*NO\*|reads as a cancellation/i);

    // Gemini's reading WINS over the local rules (LLM understands, rules only back it up)
    const r2 = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-16', startTime: '09:00', endTime: '10:00', room: 'Room 13' });
    const slot2Id = r2.json.data._id;
    geminiAnswer = 'YES';
    // 'nahi soch ra' is ambiguous to the rules-NO words, but the LLM reads it as reluctant-yes
    assert.equal((await webhook(incoming('chalo theek hai, nahi soch ra aisa, aaon ga zaroor'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slot2Id)).teacherConfirmation.status, 'confirmed');

    // Gemini UNCLEAR → falls back to the rules → still unclear → polite hint
    const r3 = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-17', startTime: '09:00', endTime: '10:00', room: 'Room 14' });
    const slot3Id = r3.json.data._id;
    geminiAnswer = 'UNCLEAR';
    const res = await webhook(incoming('mujhe abhi kuch samajh nahi aa raha'));
    assert.equal(res.json.data.updated, true); // hint sent
    assert.match(sent.at(-1).body, /plain \*YES\* or \*NO\*/);
    assert.equal((await Timetable.findById(slot3Id)).teacherConfirmation.status, 'awaiting');
  } finally {
    geminiAnswer = null; // later tests: API error → rules fallback (previous behavior)
  }
});

test('OWNER FEATURE: class reminder — short WhatsApp to the teacher ~20 min before the class', async () => {
  const { runClassReminderSweep, buildClassReminderMessage } = await import('../backend/services/classReminderService.js');
  // Mon 2026-10-05, 08:45 PKT — slots: 09:00 (due in 15), 09:18 (due in 33 → NO),
  // 07:00 (already started → NO), 11:00 (way ahead → NO)
  const nowEpoch = Date.UTC(2026, 9, 5, 3, 45); // 08:45 PKT
  const author = (await User.findOne({ email: 'cr-teacher@test.local' }))._id;
  const base = { section, subject, status: 'active', createdBy: author };
  const due = await Timetable.create({ ...base, date: '2026-10-05', startTime: '09:00', endTime: '10:00', room: 'Room 9' });
  await Timetable.create({ ...base, date: '2026-10-05', startTime: '09:18', endTime: '10:00', room: 'Room 9' });
  await Timetable.create({ ...base, date: '2026-10-05', startTime: '07:00', endTime: '08:00' });
  await Timetable.create({ ...base, date: '2026-10-05', startTime: '11:00', endTime: '12:00' });
  // yesterday's 09:00 slot must never remind (date filter)
  await Timetable.create({ ...base, date: '2026-10-04', startTime: '09:00', endTime: '10:00' });
  // a DECLINED class is not the teacher's class anymore — no reminder
  await Timetable.create({ ...base, date: '2026-10-05', startTime: '09:10', endTime: '10:00',
    teacherConfirmation: { status: 'declined' } });

  const sentBefore = sent.length;
  const r1 = await runClassReminderSweep({ nowEpoch });
  assert.equal(r1.configured, true);
  assert.equal(r1.due, 1); // only the 09:00 slot — the 09:10 DECLINED slot is excluded
  assert.equal(r1.sent, 1);
  assert.equal(sent.length, sentBefore + 1);

  // SHORT + clear: greeting, one reminder line, footer — no long template
  const msg = sent.at(-1);
  assert.equal(msg.to, '923001112233');
  assert.match(msg.body, /Assalam-o-Alaikum Respected \*Dr Test\*/);
  assert.match(msg.body, /\*Reminder:\* your \*Data Structures\* class \(4B\) starts at \*9:00 AM\* today — Room 9/);
  assert.match(msg.body, /— Tri3M Class Agent/);
  assert.ok(msg.body.length < 200, `reminder must stay SHORT (got ${msg.body.length})`);

  // exactly-once: slot is marked, a second pass sends nothing
  assert.ok((await Timetable.findById(due._id)).classReminder.sentAt, 'slot marked as reminded');
  const r2 = await runClassReminderSweep({ nowEpoch });
  assert.equal(r2.sent, 0);
  assert.equal(sent.length, sentBefore + 1);

  // gateway failure → NOT marked → the next pass retries the same slot
  await Timetable.updateOne({ _id: due._id }, { $unset: { classReminder: 1 } });
  failNext = true;
  const r3 = await runClassReminderSweep({ nowEpoch });
  assert.equal(r3.failed, 1);
  const r4 = await runClassReminderSweep({ nowEpoch });
  assert.equal(r4.sent, 1);
  assert.match(sent.at(-1).body, /\*Reminder:\*/);

  // teacher facing English, subject name, room optional
  const sample = buildClassReminderMessage({ teacher: 'Dr X', subject: 'AI', section: '2M', time: '13:30', room: '' });
  assert.ok(!sample.includes('undefined'), 'no room → clean line, no undefined');
  assert.match(sample, /1:30 PM/);
});

test('OWNER FEATURE: class reminder skips slots with no teacher linked (no message, no spam)', async () => {
  const { runClassReminderSweep } = await import('../backend/services/classReminderService.js');
  const nowEpoch = Date.UTC(2026, 9, 5, 3, 45);
  const author = (await User.findOne({ email: 'cr-teacher@test.local' }))._id;
  const slot = await Timetable.create({ section, subject: new mongoose.Types.ObjectId(), status: 'active',
    createdBy: author, date: '2026-10-05', startTime: '09:05', endTime: '10:00', room: 'R2' });
  const sentBefore = sent.length;
  const r = await runClassReminderSweep({ nowEpoch, only: slot._id });
  assert.equal(r.skippedNoTeacher, 1);
  assert.equal(r.sent, 0);
  assert.equal(sent.length, sentBefore); // silence — never an error message to anyone
  // stays unmarked → a teacher linked inside the window still gets reminded
  assert.ok(!(await Timetable.findById(slot._id)).classReminder);
});

test('hint reminders rotate through a pool so repeats never read identical', async () => {
  const { buildHintMessage } = await import('../backend/services/teacherConfirmationService.js');
  const pool = new Set(Array.from({ length: 40 }, () => buildHintMessage('Dr Test')));
  assert.ok(pool.size >= 3, `hint pool should rotate across variants (got ${pool.size})`);
  for (const body of pool) {
    assert.match(body, /plain \*YES\* or \*NO\*/);
    assert.match(body, /\*Dr Test\*/);
    assert.match(body, /reply just \*YES\* if you will take the class, or \*NO\* if you cannot/);
    assert.match(body, /— Tri3M Class Agent\nDeveloped by the students of the AI Department, IUB\nSemester 2 • Section 3M/);
  }
});

test.after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongod.stop();
});
