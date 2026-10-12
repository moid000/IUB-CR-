/* CR QUESTION DELIVERY — owner bug report 2026-10-12:
 * "Tri3M tells the teacher the question has been forwarded, but the CR never
 * receives it." Root cause (live evidence, outbox 2026-10-11 08:01/08:02):
 * the GENERAL-mode Gemini reply PROMISED CR contact ("main aap ki ye baat CR
 * tak pohuncha deta hoon") while setting escalate:false — the escalation
 * gate trusted the flag alone, so NO TeacherQuestion task was created and
 * the dispatch never happened. Functional fix: the backend now creates and
 * dispatches the durable task whenever the reply the teacher RECEIVED
 * promises CR contact, or the teacher explicitly asked "ask the CR" —
 * independent of the model's flag. Plus: teacher-turn timestamps (1970 bug)
 * and honest create-failure replies. */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
process.env.MONGODB_URI = mongod.getUri('cr_question_delivery_test');
process.env.JWT_SECRET = 'test-cr-question-delivery-jwt';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'owner@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.ULTRAMSG_INSTANCE_ID = 'test-instance';
process.env.ULTRAMSG_TOKEN = 'fake-token';
process.env.ULTRAMSG_WEBHOOK_SECRET = 'fake-webhook-secret';
process.env.DEADLINE_SWEEP_SECRET = 'fake-sweep-secret';
process.env.GOOGLE_API_KEY = 'test-key';
process.env.ALLOW_TEST_GEMINI = '1';
process.env.CLOUDINARY_CLOUD_NAME = 'demo';
process.env.CLOUDINARY_API_KEY = 'key';
process.env.CLOUDINARY_API_SECRET = 'secret';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { Teacher, TeacherQuestion, User, OutboxMessage, Note, Notification, Timetable } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const sent = []; // every WhatsApp text delivered { to, body }
let failSendsTo = null; // a phone whose sends fail (dispatch-failure test)
let geminiChatReply = null; // { reply, escalate } — the GENERAL-mode answer
let geminiAnswer = null; // YES/NO/QUESTION interpreter (class flow)

globalThis.fetch = (url, options) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com')) {
    const body = String(options.body);
    const geminiText = (obj) => new Response(JSON.stringify(
      { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });
    if (body.includes('"reply"')) {
      return Promise.resolve(geminiChatReply
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiChatReply) }] } }] }), { status: 200 })
        : new Response(JSON.stringify({}), { status: 400 }));
    }
    return Promise.resolve(geminiAnswer
      ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: geminiAnswer }) }] } }] }), { status: 200 })
      : new Response(JSON.stringify({}), { status: 400 }));
  }
  if (u.includes('api.ultramsg.com/test-instance/messages/chat')) {
    const data = new URLSearchParams(options.body);
    if (failSendsTo && String(data.get('to')).includes(failSendsTo)) {
      return Promise.resolve(new Response(JSON.stringify({ sent: false, error: 'gateway down' }), { status: 200 }));
    }
    sent.push({ to: data.get('to'), body: data.get('body') });
    return Promise.resolve(new Response(JSON.stringify({ sent: true }), { status: 200 }));
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
const webhook = (body) => admin('POST', '/api/whatsapp/teacher-reply?key=fake-webhook-secret', body);
const incoming = (text, from = '923001112233@c.us', id = `q-${Math.random()}`) => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id, from, body: text, fromMe: false, type: 'chat', time: Math.floor(Date.now() / 1000) } });

let section4B, teacher, crUser;
test.before(async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const academicSession = (await admin('POST', '/api/admin/sessions', { name: '2099–2100' })).json.data._id;
  const hash = await bcrypt.hash('CrPass123!', 10);
  crUser = await User.create({ name: 'Abdul Rehman', email: 'cr@crqd.test', phone: '923009876543', role: 'cr',
    registrationStatus: 'active', emailVerified: true, password: hash });
  section4B = (await admin('POST', '/api/admin/sections', { department: dept, session: academicSession, semester: 4, name: '4B', cr: crUser._id.toString() })).json.data._id;
  const subject4B = (await admin('POST', '/api/admin/subjects', { section: section4B, name: 'Data Structures', code: 'DS-101' })).json.data._id;
  teacher = await Teacher.create({ name: 'Dr Test', subject: subject4B, section: section4B, whatsapp: '923001112233', createdBy: crUser._id });
});
test.after(async () => {
  await mongoose.disconnect();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  await mongod.stop();
});
test.afterEach(async () => {
  geminiChatReply = null; geminiAnswer = null; failSendsTo = null;
  sent.length = 0;
  await Promise.all([OutboxMessage.deleteMany({}), TeacherQuestion.deleteMany({}), Note.deleteMany({}),
    Notification.deleteMany({}), Timetable.deleteMany({}), models.WhatsAppEvent.deleteMany({})]);
  await Teacher.updateMany({}, { $set: { conversation: [], lastChatMsgId: '' } });
});

/* The EXACT live incident: the reply the teacher received PROMISES CR
 * contact while escalate:false — the CR must STILL get a real dispatched
 * task. (live outbox 2026-10-11 08:01:59 + 08:02:34 had no task at all) */
test('QD-1: reply PROMISES CR contact with escalate:false → task STILL created + dispatched + honest ack', async () => {
  geminiAnswer = 'QUESTION';
  geminiChatReply = { escalate: false,
    reply: 'Ji Sir, main aap ki ye baat CR Abdul Rehman (03088787753) tak pohuncha deta hoon, wo jald aapse rabta kar lein ge.' };
  const from = sent.length;
  await webhook(incoming('Sir, kal DS ki class cancel ho gi?', '923001112233@c.us', 'qd1-msg'));
  geminiAnswer = null; geminiChatReply = null;
  const task = await TeacherQuestion.findOne({}).lean();
  assert.ok(task, 'task MUST exist despite escalate:false — the promise was made');
  assert.equal(task.status, 'pending_cr');
  assert.ok(task.questionKey, 'durable task record persisted before dispatch');
  const crPings = sent.slice(from).filter((s) => s.to === '923009876543');
  assert.ok(crPings.length >= 1, 'the CR really received the question');
  assert.match(crPings[crPings.length - 1].body, /Dr Test/, 'question alert names the teacher');
  assert.match(crPings[crPings.length - 1].body, /kal DS ki class cancel/, 'question text verbatim');
  assert.ok(task.crNotifiedAt, 'dispatch state persisted');
  const ack = sent.slice(from).find((s) => s.to === '923001112233' && /CR.*confirm|bhej di/i.test(s.body));
  assert.ok(ack, 'teacher acknowledged only after the dispatch');
});

/* teacher-side explicit relay request — even when the model answers with a
 * generic line and no escalate flag */
test('QD-2: "CR se poocho ..." explicit teacher request → task created regardless of the model reply', async () => {
  geminiAnswer = 'QUESTION';
  geminiChatReply = { escalate: false, reply: 'Sir, main dekh kar aap ko bata dun ga.' };
  await webhook(incoming('CR se poocho kitne students hain section mein?', '923001112233@c.us', 'qd2-msg'));
  geminiAnswer = null; geminiChatReply = null;
  const task = await TeacherQuestion.findOne({}).lean();
  assert.ok(task, 'ask-the-CR request became a durable task');
  assert.ok(sent.some((s) => s.to === '923009876543'), 'CR dispatched');
});

/* identity/contact answers must NEVER create a task */
test('QD-3: "CR ka number kya hai?" answered with contact info → NO task, no CR ping', async () => {
  geminiAnswer = 'QUESTION';
  geminiChatReply = { escalate: false,
    reply: 'Aap ke CR Abdul Rehman hain, unka number 03088787753 hai — rabta kar lein.' };
  await webhook(incoming('CR ka number kya hai?', '923001112233@c.us', 'qd3-msg'));
  geminiAnswer = null; geminiChatReply = null;
  assert.equal(await TeacherQuestion.countDocuments({}), 0, 'identity/contact answer is not a relay');
  assert.ok(!sent.some((s) => s.to === '923009876543'), 'CR never pinged for their own number');
});

/* teacher says they will ask the CR themselves — no task */
test('QD-4: teacher SELF-contact ("main khud pooch loongi") → no task', async () => {
  geminiAnswer = 'QUESTION';
  geminiChatReply = { escalate: false, reply: 'Ji Ma\'am, bilkul. Kuch aur poochna ho to bataiye.' };
  await webhook(incoming('koi baat nahi, main khud CR se pooch loongi', '923001112233@c.us', 'qd4-msg'));
  geminiAnswer = null; geminiChatReply = null;
  assert.equal(await TeacherQuestion.countDocuments({}), 0, 'self-contact is not a relay');
});

/* dispatch failure: honest to the teacher, real error persisted */
test('QD-5: dispatch FAILS → teacher told could-not-send (never "forwarded"), real error persisted', async () => {
  failSendsTo = '923009876543';
  geminiAnswer = 'QUESTION';
  geminiChatReply = { escalate: true, reply: 'Sir, main CR se confirm kar ke aap ko bata dun ga.' };
  const from = sent.length;
  await webhook(incoming('Kal test hai?', '923001112233@c.us', 'qd5-msg'));
  geminiAnswer = null; geminiChatReply = null;
  const task = await TeacherQuestion.findOne({}).lean();
  assert.ok(task, 'task exists (durable record before dispatch)');
  assert.ok(!task.crNotifiedAt, 'no fake notified state');
  assert.match(String(task.crNotifyError ?? ''), /gateway down/, 'REAL failure reason persisted');
  const ack = sent.slice(from).filter((s) => s.to === '923001112233');
  assert.ok(!ack.some((m) => /bhej di hai|forwarded/i.test(m.body)),
    'teacher is NEVER told it was forwarded on failure');
});

/* multiple pending questions: never blocked, never blind-linked */
test('QD-6: TWO distinct questions independently dispatched; CR reply binds by ref code; un-coded reply gets disambiguation', async () => {
  geminiAnswer = 'QUESTION';
  geminiChatReply = { escalate: true, reply: 'Sir, main CR se pooch kar bata dun ga.' };
  await webhook(incoming('Kal ki class hai?', '923001112233@c.us', 'qd6-a'));
  await webhook(incoming('Test kis din hai?', '923001112233@c.us', 'qd6-b'));
  geminiAnswer = null; geminiChatReply = null;
  assert.equal(await TeacherQuestion.countDocuments({}), 2, 'two distinct questions, two tasks — nothing blocked');
  assert.equal(sent.filter((s) => s.to === '923009876543').length, 2, 'each independently dispatched');
  // CR replies WITHOUT a code while two are pending → asked WHICH, never blind
  const which = incoming('Ji kal ki class Library mein hai', '923009876543@c.us', 'qd6-cr-ambiguous');
  const r1 = await webhook(which);
  const askedCode = sent.filter((s) => s.to === '923009876543' && /kis ka jawab|Code likh/i.test(s.body));
  assert.ok(askedCode.length >= 1, 'CR asked which question the reply is for');
  // CR replies WITH the first task's code → binds to exactly that task
  const [t1] = await TeacherQuestion.find({}).sort({ askedAt: 1 }).lean();
  const coded = incoming(`${t1.refCode} Ji kal ki class Library mein hai`, '923009876543@c.us', 'qd6-cr-coded');
  await webhook(coded);
  const bound = await TeacherQuestion.findById(t1._id).lean();
  // closed ONLY after the answer was really delivered to the teacher
  assert.equal(bound.status, 'closed', 'coded reply bound + answered end-to-end');
  assert.match(String(bound.crReply ?? ''), /Library mein hai/, 'the CR answer stored on the CODED task');
  assert.ok(sent.some((m) => m.to === '923001112233' && /Library mein hai/.test(m.body)),
    'teacher received the answer to the FIRST question');
  const other = (await TeacherQuestion.find({ status: 'pending_cr' }).lean());
  assert.equal(other.length, 1, 'the second question stays open');
});

/* 1970-timestamp bug: teacher turns must be real dates so history replays */
test('QD-7: teacher conversation turns stored with REAL timestamps (not 1970)', async () => {
  geminiAnswer = 'QUESTION';
  geminiChatReply = { escalate: false, reply: 'Sir, main dekh kar bata dun ga.' };
  await webhook(incoming('Assalam o alaikum Sir ko salam', '923001112233@c.us', 'qd7-msg'));
  geminiAnswer = null; geminiChatReply = null;
  const doc = await Teacher.findById(teacher._id).lean();
  const teacherTurns = (doc.conversation ?? []).filter((m) => m.role === 'teacher');
  assert.ok(teacherTurns.length >= 1, 'teacher turn recorded');
  const at = new Date(teacherTurns[teacherTurns.length - 1].at).getTime();
  assert.ok(Math.abs(Date.now() - at) < 5 * 60 * 1000, `turn timestamp is NOW (got ${new Date(at).toISOString()})`);
});

/* same question re-asked → task REUSED, no CR spam */
test('QD-8: same question re-asked → task reused, no duplicate dispatch', async () => {
  geminiAnswer = 'QUESTION';
  geminiChatReply = { escalate: true, reply: 'Sir, main CR se pooch kar bata dun ga.' };
  await webhook(incoming('Kal ki class hai?', '923001112233@c.us', 'qd8-a'));
  await webhook(incoming('Kal ki class hai?', '923001112233@c.us', 'qd8-b'));
  geminiAnswer = null; geminiChatReply = null;
  assert.equal(await TeacherQuestion.countDocuments({}), 1, 'one durable task per distinct question');
  assert.equal(sent.filter((s) => s.to === '923009876543').length, 1, 'CR pinged once');
});
