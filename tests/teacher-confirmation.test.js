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
process.env.OPENAI_API_KEY = 'test-openai-key'; // OWNER night #8: teacher voice notes
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
let geminiAnswer = null; // 'YES' | 'NO' | 'QUESTION' | 'UNCLEAR' | null (null = API error → rules fallback)
let geminiChatReply = null; // OWNER 2026-10-07: human conversation reply ({reply} schema) — null = API error → static fallback
let voiceTranscript = null; // OWNER night #8: what Whisper returns for the teacher's voice note (null = STT failure)
let geminiVoiceTranscript = null; // OWNER 2026-10-08: Gemini STT transcript (null = Gemini STT down → Whisper fallback)
const voiceMsg = (from = '923001112233@c.us') => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id: `incoming-${Math.random()}`, from, body: '', type: 'voice', link: 'https://cdn.example/voice.ogg',
    fromMe: false, time: Math.floor(Date.now() / 1000) } });
const geminiDownModels = new Set(); // OWNER 2026-10-07 night: model names serving 503 (live incident)
const geminiBodies = []; // OWNER MASTER SPEC (night #3): every LLM call's payload (history assertions)
globalThis.fetch = (url, options) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    // OWNER 2026-10-08: Gemini STT (inline audio) routed separately from classify/chat calls
    if (String(options.body).includes('"inlineData"')) {
      return geminiVoiceTranscript
        ? Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: geminiVoiceTranscript }] } }] }), { status: 200 }))
        : Promise.resolve(new Response(JSON.stringify({}), { status: 400 }));
    }
    geminiBodies.push({ url: String(url), body: String(options.body) });
    if ([...geminiDownModels].some((m) => String(url).includes(`/models/${m}:`))) {
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } }), { status: 503 }));
    }
    const isChat = String(options.body).includes('"reply"'); // teacher conversation uses the {reply} schema
    if (isChat && geminiChatReply) {
      const payload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: geminiChatReply }) }] } }] };
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }
    if (!isChat && geminiAnswer) {
      const payload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: geminiAnswer }) }] } }] };
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 400 })); // API down → fallbacks
  }
  if (String(url).includes('voice.ogg')) { // OWNER night #8: teacher voice note download
    return Promise.resolve(new Response('fake-ogg-bytes'));
  }
  if (String(url).includes('api.openai.com')) { // OWNER night #8: Whisper mock
    return voiceTranscript
      ? Promise.resolve(new Response(JSON.stringify({ text: voiceTranscript }), { status: 200 }))
      : Promise.resolve(new Response(JSON.stringify({ error: 'stt unavailable' }), { status: 500 }));
  }
  if (String(url).includes('api.ultramsg.com/test-instance/messages?')) {
    // OWNER INCIDENT 2026-10-08: messages-by-id lookup for a ptt with no link
    return Promise.resolve(new Response(JSON.stringify({ messages: [{ link: 'https://cdn.example/voice.ogg' }] })));
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
  assert.match(sent[1].body, /www\.tri2m\.com/); // custom domain (owner 2026-10-05)
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
    assert.match(body, /www\.tri2m\.com/); // custom domain (owner 2026-10-05)
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
  assert.match(sent.at(-1).body, /Assalam-o-Alaikum Respected \*Dr Test\*/);
  assert.match(sent.at(-1).body, /plain \*YES\* or \*NO\*/);
  // OWNER 2026-10-07: human tone — no robot talk, no team/offline canned text
  assert.doesNotMatch(sent.at(-1).body, /AI (agent|assistant)|automated|offline|team|support/i);
  assert.match(sent.at(-1).body, /— Tri3M Class Agent/);
  const after = (await Timetable.findById(slotId)).teacherConfirmation;
  assert.equal(after.status, 'awaiting'); // a hint never answers the question
  assert.equal(after.attempts, before.attempts); // and never consumes a retry

  // night #7: a second unclear reply is a NEW message — it gets its own hint (never silence)
  assert.equal((await webhook(incoming('pata nahi abhi, baad me bataon ga'))).json.data.updated, true);
  assert.equal(sent.length, sentBefore + 2);

  // the teacher can still answer normally right after the hint
  assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');

  // once the question is resolved, further chatter gets no auto-reply
  assert.equal((await webhook(incoming('ok theek ha'))).json.data.updated, false);
  assert.equal(sent.length, sentBefore + 3); // two hints + the thank-you follow-up
});

test('unrecognized replies from strangers or group numbers never trigger a hint', async () => {
  const sentBefore = sent.length;
  assert.equal((await webhook(incoming('yes betha ma aaon ga', '923009990011@c.us'))).json.data.updated, false);
  assert.equal((await webhook(incoming('hello', '120363abc@g.us'))).json.data.updated, false);
  assert.equal(sent.length, sentBefore); // nothing sent to anyone
});

test('OWNER FEATURE: interpretReply — natural-language YES/NO in Roman Urdu, English and mixed', async () => {
  const { interpretReply, interpretTeacherReply } = await import('../backend/services/teacherConfirmationService.js');
  // YES in the wild
  for (const yes of ['g beta kl class ho gi time p ho gi', 'yes betha ma aaon ga', 'G bilkul ho gi sir',
    'inshallah aaon ga', 'no problem, ho gi', 'ji zaroor aaonga', 'theek hai chalega',
    'theek ha ma class loon ga', 'yes sir ma aa jaon ga', 'han class ho gi', 'jee class ho gi',
    'ma class loon ga']) {
    assert.equal(interpretReply(yes), 'YES', `expected YES: ${yes}`);
  }
  // OWNER MASTER SPEC (night #4) §2: "OK" IS NOT CLASS CONFIRMATION — bare
  // acknowledgements are ACK, they must never confirm a class
  for (const ack of ['ok', 'okay', 'okay sir', 'ok sir', 'acha', 'achha', 'alright',
    'got it', 'understood', 'fine', 'thanks', 'thank you sir', 'shukriya', 'theek ha',
    'theek hai', 'ok got it', 'acha sir', 'sahi hai']) {
    assert.equal(interpretReply(ack), 'ACK', `expected ACK: ${ack}`);
  }
  // OWNER MASTER SPEC §21-A (night #5): "NO MORE QUESTIONS" IS NOT A DECLINE
  for (const nomore of ['nahi', 'nahi koi nahi', 'nahi koi question nahi', 'nahi kuch nahi poochna',
    'no, nothing', 'no thank you', 'nahi sir', 'bas itna hi', 'aur kuch nahi', 'kuch nahi',
    'nothing else', 'no more questions', "that's all", 'that is it', 'nahi chahiye',
    'nahi koi detail nahi chahiye', 'no nothing', 'bas']) {
    const v = interpretReply(nomore);
    assert.ok(v === 'ACK' || v === 'NO', `bare-no family must never confirm: ${nomore} -> ${v}`);
  }
  // explicit "no more questions" phrasings are context-free ACK (§21-A)
  for (const nomore of ['nahi koi nahi', 'nahi koi detail nahi chahiye', 'kuch nahi', 'bas itna hi',
    'aur kuch nahi', 'nothing else', 'no more questions', 'nahi chahiye', 'no thank you']) {
    assert.equal(interpretReply(nomore), 'ACK', `expected ACK (no more questions): ${nomore}`);
  }
  // but a REAL decline is still a decline (§21-D)
  for (const no of ['nahi sir ma class nahi loon ga', 'ma class nahi le sakta', 'aj ma available nahi hoon',
    'nahi, class nahi ho gi', 'i cannot take the class', "i won't be able to make it", 'please mark me unavailable']) {
    assert.equal(interpretReply(no), 'NO', `expected NO (clear decline): ${no}`);
  }
  // and a real acceptance outranks stray 'nahi' words
  assert.equal(interpretReply('nahi kuch nahi poochna, ma class le loon ga'), 'YES');
  assert.equal(interpretReply('nahi chahiye detail, bas aaon ga'), 'YES');
  // NO in the wild — OWNER BUG CASE (2026-10-04): 'mera dil ni ha' was wrongly
  // confirmed as YES ('ni' missing from negation, 'ha' falsely read as haan)
  for (const no of ['mera dil ni ha', 'mera dil nahi hai class ka', 'mujy maan ni ha class ki',
    'mood nahi hai', 'ma a ni aa sakta', 'nahi ho gi, urgent kaam hai', 'cancel kar do aj ki',
    'ma class ni loon ga', 'ma class ni le sakta', 'aj class possible ni',
    'g nahi bhai, chutti hai', 'busy hoon aa nahi sakta']) {
    assert.equal(interpretReply(no), 'NO', `expected NO: ${no}`);
  }
  // YES still solid after the fix — weak words ('ha' as bare hai, 'ya' = or) removed
  for (const yes of ['ha beta ho gi', 'haan zaroor aaon ga']) {
    assert.equal(interpretReply(yes), 'YES', `expected YES: ${yes}`);
  }
  // OWNER MASTER SPEC night #4: Gemini's ACK verdict passes through
  geminiAnswer = 'ACK';
  try {
    assert.equal(await interpretTeacherReply('acha'), 'ACK');
    assert.equal(await interpretTeacherReply('ok got it sir'), 'ACK');
  } finally { geminiAnswer = null; }
  // ...and a Gemini YES on a bare acknowledgement is overridden to ACK (§2)
  geminiAnswer = 'YES';
  try {
    assert.equal(await interpretTeacherReply('okay sir'), 'ACK');
    assert.equal(await interpretTeacherReply('ok'), 'ACK');
    // a real YES still stands
    assert.equal(await interpretTeacherReply('ok sir, ma class loon ga'), 'YES');
  } finally { geminiAnswer = null; }
  // §21-A: a Gemini NO on a "no more questions" reply is overridden to ACK
  geminiAnswer = 'NO';
  try {
    assert.equal(await interpretTeacherReply('nahi koi nahi'), 'ACK');
    assert.equal(await interpretTeacherReply('nothing else'), 'ACK');
    // a real decline still stands
    assert.equal(await interpretTeacherReply('ma class nahi loon ga'), 'NO');
  } finally { geminiAnswer = null; }
  // OWNER 2026-10-07: basic QUESTIONS route to the full-details answer card
  for (const q of ['which section is this?', 'which semester is this?', 'konsa section hai ye?',
    'kaun sa room hai?', 'who is the CR?', 'cr kaun hai?', 'kab hai class?',
    'mujhe samajh nahi aa raha ye konsi class hai']) {
    assert.equal(interpretReply(q), 'QUESTION', `expected QUESTION: ${q}`);
  }
  // OWNER BUG (2026-10-07 night, LIVE incident): teacher replied 'g kon?'
  // (who is this?) to the pre-class reminder and the class got CONFIRMED —
  // 'g' (polite ji) matched the YES list. Identity questions now outrank.
  for (const q of ['g kon?', 'g kaun?', 'kon?', 'kon ho tum?', 'aap kon?', 'g who?',
    'who is this?', 'who?', 'kab?', 'kahan?']) {
    assert.equal(interpretReply(q), 'QUESTION', `expected QUESTION: ${q}`);
  }
  // a lone polite 'g'/'ji' with no question is still a YES
  for (const yes of ['g', 'ji', 'g sir']) {
    assert.equal(interpretReply(yes), 'YES', `expected YES: ${yes}`);
  }
  // OWNER BUG (2026-10-07 night #2, LIVE): 'ye kis ka number hai?' got the
  // canned 'Sorry for the confusion' hint. Informational questions NEVER get
  // the hint — they route to the human conversation.
  for (const q of ['ye kis ka number hai?', 'number konsa hai?', 'ap ka number kis ka hai?',
    'kis ka number hai ye?', 'class kaise hogi?', 'how are you?']) {
    assert.equal(interpretReply(q), 'QUESTION', `expected QUESTION: ${q}`);
  }
  // genuine maybes stay UNCLEAR (hint is correct there)
  for (const u of ['maybe', 'shayad bata donga', 'ho jaye ga dekh ke']) {
    assert.equal(interpretReply(u), null, `expected UNCLEAR: ${u}`);
  }
  // genuinely unclear — never guessed, hint path instead
  for (const unclear of ['pata nahi abhi', 'acha, dekh ke bataon ga', 'maybe', 'thori der me bataon ga']) {
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
  assert.match(ack.body, /www\.tri2m\.com/); // custom domain (owner 2026-10-05)
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

test('OWNER MASTER SPEC §22-D (night #6): the pre-class reminder ITSELF asks for the YES/NO while confirmation is still pending', async () => {
  const { buildClassReminderMessage } = await import('../backend/services/classReminderService.js');
  const awaiting = buildClassReminderMessage({ teacher: 'Dr X', subject: 'AI', section: '2M', time: '13:30', room: '', awaitingConfirmation: true });
  assert.match(awaiting, /Kya aap ye class lein ge, Sir\?/);
  assert.match(awaiting, /YES/);
  const decided = buildClassReminderMessage({ teacher: 'Dr X', subject: 'AI', section: '2M', time: '13:30', room: '', awaitingConfirmation: false });
  assert.doesNotMatch(decided, /Kya aap ye class lein ge/);
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

test('OWNER RULE: teacher gave NO response (question awaiting) → reminder STILL goes', async () => {
  const { runClassReminderSweep } = await import('../backend/services/classReminderService.js');
  const author = (await User.findOne({ email: 'cr-teacher@test.local' }))._id;
  const nowEpoch = Date.UTC(2026, 9, 5, 3, 45); // 08:45 PKT
  const slot = await Timetable.create({ section, subject, status: 'active', createdBy: author,
    date: '2026-10-05', startTime: '09:05', endTime: '10:00', room: 'R3',
    teacherConfirmation: { status: 'awaiting', phone: '923001112233', attempts: 1 } });
  const sentBefore = sent.length;
  const r = await runClassReminderSweep({ nowEpoch, only: slot._id });
  // no YES/NO received → the class reminder still fires — only DECLINED is excluded
  assert.equal(r.sent, 1);
  assert.equal(sent.length, sentBefore + 1);
  assert.match(sent.at(-1).body, /\*Reminder:\*/);
});

test('OWNER FEATURE: CR manual override — teacher confirmed on a phone call (no WhatsApp reply)', async () => {
  // close stale questions from earlier tests so the ONE-QUESTION-QUEUE for
  // this teacher's phone is free for this scenario
  await Timetable.updateMany({ 'teacherConfirmation.status': { $in: ['queued', 'sending', 'awaiting', 'failed'] } },
    { $set: { 'teacherConfirmation.status': 'none' } });
  // a class with a live WhatsApp question the teacher never answers
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-02-02', startTime: '09:00', endTime: '10:00', room: 'Room 1' });
  const slotId = r.json.data._id;
  // creation auto-dispatches the WhatsApp question → teacher goes silent
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');

  // CR called the teacher → sets the status manually from the portal
  const ov = await cr('POST', `/api/cr/timetable/${slotId}/confirmation-override`, { status: 'confirmed' });
  assert.equal(ov.status, 200);
  let slot = await Timetable.findById(slotId);
  assert.equal(slot.teacherConfirmation.status, 'confirmed');
  assert.ok(slot.teacherConfirmation.manualBy, 'manualBy marks the CR phone-call override');
  assert.ok(slot.teacherConfirmation.manualAt);
  assert.ok(slot.teacherConfirmation.respondedAt);
  assert.ok(ov.json.data.teacherConfirmation.manualBy, 'response feeds the "· set by CR" badge');

  // OWNER RULE: the AUTOMATIC flow is untouched — a LATE exact-code WhatsApp
  // NO cannot flip a slot the CR already answered (reply filter requires an
  // open awaiting/sending/failed question; this one is answered)
  const res = await webhook(incoming(`NO ${slot.teacherConfirmation.code}`));
  assert.equal(res.json.data.updated, false);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');

  // the queue keeps flowing: the teacher's NEXT queued class dispatches and
  // is still answered normally over WhatsApp (no manualBy on it)
  const r2 = await cr('POST', '/api/cr/timetable', { subject, date: '2099-02-02', startTime: '10:00', endTime: '11:00' });
  const slot2Id = r2.json.data._id;
  await Timetable.updateOne({ _id: slot2Id }, { $set: { 'teacherConfirmation.nextAttemptAt': new Date(0) } });
  await admin('GET', '/api/whatsapp/deadline-sweep?secret=fake-sweep-secret');
  assert.equal((await Timetable.findById(slot2Id)).teacherConfirmation.status, 'awaiting');
  assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
  const slot2 = await Timetable.findById(slot2Id);
  assert.equal(slot2.teacherConfirmation.status, 'confirmed');
  assert.ok(!slot2.teacherConfirmation.manualBy, 'WhatsApp answer — no manual mark');
});

test('OWNER FEATURE: manual override validation + a phone-call NO also cancels', async () => {
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-02-03', startTime: '11:00', endTime: '12:00' });
  const slotId = r.json.data._id;

  // invalid status rejected
  assert.equal((await cr('POST', `/api/cr/timetable/${slotId}/confirmation-override`, { status: 'maybe' })).status, 400);
  // students can never touch the CR override endpoint
  assert.equal((await student('POST', `/api/cr/timetable/${slotId}/confirmation-override`, { status: 'confirmed' })).status, 403);

  // teacher told the CR "class nahi hogi" on the call → manual decline
  const ov = await cr('POST', `/api/cr/timetable/${slotId}/confirmation-override`, { status: 'declined' });
  assert.equal(ov.status, 200);
  const slot = await Timetable.findById(slotId);
  assert.equal(slot.teacherConfirmation.status, 'declined');
  assert.ok(slot.teacherConfirmation.manualBy);
  // the 20-min pre-class reminder reads the SAME status → a manual decline
  // is excluded exactly like a WhatsApp NO
  const { runClassReminderSweep } = await import('../backend/services/classReminderService.js');
  const nowEpoch = Date.UTC(2099, 1, 3, 5, 45); // 10:45 PKT, 15 min before 11:00
  const sweep = await runClassReminderSweep({ nowEpoch, only: slotId });
  assert.equal(sweep.due, 0, 'manually declined class gets no reminder');
});

test('OWNER FEATURE (2026-10-07): QUESTION + conversation API down → professional full-details card fallback (YES/NO stays open)', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-20', startTime: '09:00', endTime: '10:00', room: 'Room 20' });
  const slotId = r.json.data._id;
  const sentBefore = sent.length;

  // Gemini reads the MEANING: a confused teacher asking which section / CR
  geminiAnswer = 'QUESTION';
  try {
    const res = await webhook(incoming('mujhe samajh nahi aa raha, ye konsa section hai aur CR kaun hai?'));
    assert.equal(res.json.data.updated, true); // handled — the teacher got an answer, not silence

    const card = sent.at(-1);
    assert.equal(card.to, teacher.whatsapp);
    assert.match(card.body, /Tri3M Class Agent/);
    assert.match(card.body, /Department: \*Computer Science\*/);
    assert.match(card.body, /Semester: \*4\*/);
    assert.match(card.body, /Section: \*4B\*/);
    assert.match(card.body, /Subject: \*Data Structures\*/);
    assert.match(card.body, /Room: \*Room 20\*/);
    assert.match(card.body, /Alex Representative/);            // the real CR's name
    assert.match(card.body, /\+?923009876543/);                // the CR's phone number
    assert.match(card.body, /please reply/i);                   // YES/NO still requested
    assert.match(card.body, /\*YES\*/);
    assert.match(card.body, /\*NO\*/);

    // the open question is NEVER answered or consumed by the explanation
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');

    // night #7: rapid follow-up questions are answered IMMEDIATELY (no cooldown)
    const count = sent.length;
    assert.equal((await webhook(incoming('aur room konsa hai?'))).json.data.updated, true);
    assert.equal(sent.length, count + 1);
    assert.equal((await webhook(incoming('room konsa hai?'))).json.data.updated, true);
    assert.equal(sent.length, count + 2);

    // the teacher can still answer normally right after asking questions
    assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
  } finally {
    geminiAnswer = null; // later tests: API error → rules fallback
  }
});

test('OWNER FEATURE (2026-10-07): offline safety net — ONE question gets that ONE answer, broad questions get the card (MASTER SPEC §3)', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-21', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  // geminiAnswer = null → API 400 → local rules → QUESTION → selective offline answer
  assert.equal((await webhook(incoming('which semester is this?'))).json.data.updated, true);
  const ans = sent.at(-1);
  assert.match(ans.body, /Semester \*4\*/);          // exactly what was asked
  assert.match(ans.body, /YES \* or \*NO|YES\* or \*NO/); // one soft ask while awaiting
  assert.doesNotMatch(ans.body, /Department:/);         // no details dump (MASTER SPEC §3)
  assert.doesNotMatch(ans.body, /Alex Representative/); // unrequested facts stay out
  // question stays open, teacher answers, class confirmed
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
  assert.equal((await webhook(incoming('NO'))).json.data.updated, true);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'declined');
});

test('OWNER UPGRADE (2026-10-07): teacher questions get a HUMAN conversational reply — answers only what was asked', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-22', startTime: '09:00', endTime: '10:00', room: 'Room 22' });
  const slotId = r.json.data._id;

  geminiAnswer = 'QUESTION'; // classifier: the teacher is asking a question
  geminiChatReply = 'Ji sir, ye aap ki Data Structures ki class hai — Section 4B, Semester 4 (CS). Room 22, 9:00 se. Aur kuch poochhna ho to batain.';
  try {
    const res = await webhook(incoming('ye konsi class hai aur konsa section hai?'));
    assert.equal(res.json.data.updated, true);

    const reply = sent.at(-1);
    assert.equal(reply.to, teacher.whatsapp);
    // the human reply is sent VERBATIM — no canned wrapper, no robot talk
    assert.equal(reply.body, geminiChatReply);
    assert.doesNotMatch(reply.body, /offline|team|contact karen|AI (agent|assistant)|automated/i);
    // the open YES/NO question is still fully intact
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');

    // night #7: a second question is a new message — answered, never silenced
    const count = sent.length;
    assert.equal((await webhook(incoming('room konsa hai phir?'))).json.data.updated, true);
    assert.equal(sent.length, count + 1);

    // the teacher can still answer normally right after the conversation
    assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }
});

test('OWNER UPGRADE (2026-10-07): an unclear reply gets a human clarification request — never robot talk or team-offline text', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-23', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  geminiAnswer = 'UNCLEAR'; // classifier could not read it as YES/NO/QUESTION
  geminiChatReply = 'Sir aap ka paighaam theek se samajh nahi aaya. Class confirm karni ho to bas YES ya NO likh dein — students ko foran status nazar aa jata hai.';
  try {
    const res = await webhook(incoming('acha haan wo bhi aur ye bhi'));
    assert.equal(res.json.data.updated, true);

    const reply = sent.at(-1);
    assert.equal(reply.body, geminiChatReply);
    assert.doesNotMatch(reply.body, /offline|team|AI (agent|assistant)|automated|bot\b/i);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }
});

test('OWNER BUG FIX (2026-10-07 night): "g kon?" after a reminder can NEVER confirm a class — human answer instead', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-24', startTime: '09:00', endTime: '10:00', room: 'Room 24' });
  const slotId = r.json.data._id;

  // Gemini MISREADS the question as YES (the exact live failure mode)
  geminiAnswer = 'YES';
  geminiChatReply = 'Assalam-o-Alaikum sir! Main [CR] ki taraf se text kar raha hun — section ka class agent (Tri3M Class Agent). Aap ki class ki status update ke liye YES ya NO bhej dein.';
  try {
    // unit level: the guard flips a question-looking YES verdict to QUESTION
    const { interpretTeacherReply } = await import('../backend/services/teacherConfirmationService.js');
    assert.equal(await interpretTeacherReply('g konsa room hai?'), 'QUESTION'); // NO misread guarded too
    assert.equal(await interpretTeacherReply('haan ji konsa room hai?'), 'YES'); // a REAL yes still stands

    // live flow: question → human conversation, class NOT confirmed
    const res = await webhook(incoming('g kon?'));
    assert.equal(res.json.data.updated, true);
    assert.equal(sent.at(-1).body, geminiChatReply);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');

    // the teacher can still confirm normally afterwards
    assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }
});

test('OWNER BUG FIX: teacher asking "g kon?" about an ALREADY-CONFIRMED class (reminder case) still gets a human answer', async () => {
  // TIME-FLAKE FIX (v2): '+90 min from now' crosses MIDNIGHT when the suite
  // runs late at night — assertRange rejects a 23:xx start with a next-day
  // 00:xx end ('startTime must be before endTime'). Schedule TOMORROW
  // 09:00–09:50 PKT instead: always valid, still today-or-tomorrow, so the
  // reminder fallback path still matches.
  const pkf = (d, o) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', ...o }).format(d);
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  const r = await cr('POST', '/api/cr/timetable', {
    subject,
    date: pkf(tomorrow),
    startTime: '09:00',
    endTime: '09:50',
  });
  const slotId = r.json.data._id;
  assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');

  geminiAnswer = 'QUESTION';
  geminiChatReply = 'Ji sir, main aap ke section CR ki taraf se text kar raha hun — Tri3M Class Agent. Aap ki 11:00 wali class already confirmed hai.';
  try {
    const res = await webhook(incoming('g kon?'));
    assert.equal(res.json.data.updated, true);
    assert.equal(sent.at(-1).body, geminiChatReply);
    // status untouched by the conversation
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }
});

test('OWNER BUG FIX (2026-10-07 night): primary Gemini model 503 (live incident) → BACKUP model still gives the human reply', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-25', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  geminiAnswer = 'QUESTION';
  geminiChatReply = 'Sir, main Tri3M ka AI chatbot hun — CR ke taraf se class confirm karne ke liye text kar raha hun. Kindly YES ya NO bata dein.';
  geminiDownModels.add('gemini-flash-latest'); // the exact live 503 failure
  try {
    const res = await webhook(incoming('ap kon ho?'));
    assert.equal(res.json.data.updated, true);
    assert.equal(sent.at(-1).body, geminiChatReply); // backup model answered
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
    geminiDownModels.clear();
  }
});

test('OWNER BUG FIX: ALL Gemini models down + "ap kon ho?" → SHORT honest AI-chatbot intro, never the details card', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-26', startTime: '09:00', endTime: '10:00', room: 'Room 26' });
  const slotId = r.json.data._id;

  // geminiAnswer/geminiChatReply null → every model 400 → offline fallbacks
  assert.equal((await webhook(incoming('ap kon ho?'))).json.data.updated, true);
  const intro = sent.at(-1);
  assert.equal(intro.to, teacher.whatsapp);
  assert.match(intro.body, /Tri3M Class Agent/);
  assert.match(intro.body, /AI class-coordination assistant/); // honest identity, master-spec tone
  assert.match(intro.body, /Alex Representative/);     // the real CR
  assert.match(intro.body, /Room 26|9:00/);             // the class context in one line
  assert.match(intro.body, /\*YES\*/);
  assert.doesNotMatch(intro.body, /Department:/);      // NOT the full details card
  // detail questions still get the card, not the intro
  assert.equal((await webhook(incoming('konsa room hai aur semester konsa hai?'))).json.data.updated, true);
  assert.match(sent.at(-1).body, /Department: \*Computer Science\*/);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
});

test('OWNER MASTER SPEC §2/§7 (night #4): "OK" is NOT confirmation — the bot asks for the real decision, and a real YES still works', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-29', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;
  const sentBefore = sent.length;

  // "ok" acknowledges — it must NOT confirm the class
  assert.equal((await webhook(incoming('ok'))).json.data.updated, true);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
  const ask = sent.at(-1);
  assert.match(ask.body, /will you be taking|lein ge|class lein|confirm|conduct karein/i); // a natural confirm-ask
  assert.doesNotMatch(ask.body, /Sorry|confusion/i);                 // no robotic hint

  // night #7: a second ack is a new message — it gets its own (varied) confirm-ask
  assert.equal((await webhook(incoming('acha'))).json.data.updated, true);
  assert.equal(sent.length, sentBefore + 2);

  // a clear Roman Urdu YES now confirms the class
  assert.equal((await webhook(incoming('han class ho gi'))).json.data.updated, true);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
  assert.match(sent.at(-1).body, /confirm/i); // the understood-as-YES ack (pool variants say confirmed/YES)

  // after the decision, a bare 'ok' gets silence — the flow is complete (§11)
  assert.equal((await webhook(incoming('ok'))).json.data.updated, false);
});

test('OWNER night #8 ESCALATION: "CR se keh do alternate arrange kare" — teacher acknowledged, CR notified on WhatsApp + portal, class stays PENDING', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-14', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;
  const crDoc = await User.findOne({ email: 'cr-teacher@test.local' });

  geminiAnswer = 'ESCALATION'; // classifier: human action needed
  geminiChatReply = null;      // chat model DOWN → static escalation fallback
  try {
    const before = sent.length;
    assert.equal((await webhook(incoming('meri car kharab hai, aap CR se keh do alternate arrange kare'))).json.data.updated, true);
    // teacher gets a warm acknowledgment, the \u00a722 ask, never silence
    assert.equal(sent.length, before + 2); // teacher reply + CR WhatsApp alert
    const teacherReply = sent[sent.length - 2];
    assert.equal(teacherReply.to, teacher.whatsapp);
    assert.match(teacherReply.body, /pohncha diya hai/);
    assert.match(teacherReply.body, /Kya aap ye scheduled class lein ge/); // \u00a722 loop keeps running
    // the CR gets the verbatim message + class context
    const crAlert = sent[sent.length - 1];
    assert.equal(crAlert.to, '923009876543');
    assert.match(crAlert.body, /meri car kharab hai/);
    assert.match(crAlert.body, /Dr Test/);
    assert.match(crAlert.body, /pending/);
    // in-app portal notification too
    const notif = await models.Notification.findOne({ recipient: crDoc._id, type: 'system' });
    assert.ok(notif, 'portal notification created');
    assert.match(notif.message, /meri car kharab hai/);
    // the class status NEVER changes from an escalation
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
    // the classifier prompt now carries the experience library + ESCALATION category
    const lastClassify = geminiBodies.filter((b) => !b.body.includes('"reply"')).at(-1);
    assert.match(lastClassify.body, /ESCALATION/);
    assert.match(lastClassify.body, /EXAMPLES \(real teacher replies/);
  } finally {
    geminiAnswer = null; geminiChatReply = null;
  }
});

test('OWNER night #8 ESCALATION (chat model UP): Gemini words the acknowledgment — CR still notified exactly once', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-15', startTime: '09:00', endTime: '10:00' });

  geminiAnswer = 'ESCALATION';
  geminiChatReply = 'Ji Sir, aapka message CR Alex Representative ke pohncha diya hai, wo aapse khud rabta karen ge. Kya aap aaj ki class lein ge, Sir?';
  try {
    const before = sent.length;
    assert.equal((await webhook(incoming('class 10 baje tak shift kar dein'))).json.data.updated, true);
    assert.equal(sent.length, before + 2);
    assert.equal(sent[sent.length - 2].body, geminiChatReply); // Gemini's exact wording
    assert.equal(sent[sent.length - 1].to, '923009876543');
  } finally {
    geminiAnswer = null; geminiChatReply = null;
  }
});

test('OWNER 2026-10-08 FREE VOICE: Gemini STT (no OpenAI credits needed) confirms the class', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-21', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;
  voiceTranscript = null; // Whisper would fail — the free Gemini path must carry it
  geminiVoiceTranscript = 'ji haan, main lein ge';
  try {
    assert.equal((await webhook(voiceMsg())).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
  } finally {
    geminiVoiceTranscript = null;
  }
});

test('OWNER INCIDENT 2026-10-08: teacher ptt arrives with NO media link → messages-by-id fallback finds it, transcribes, confirms', async () => {
  // the live incident: real teacher ptt had NO data.link and the fallback
  // crashed on env.ultramsg (undefined) — voice died with no reply
  const { env: cfg } = await import('../backend/config/env.js');
  const had = { id: cfg.whatsapp.instanceId, token: cfg.whatsapp.token, url: cfg.whatsapp.apiUrl };
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-23', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;
  voiceTranscript = null;
  geminiVoiceTranscript = 'ji haan, main lein ge';
  try {
    cfg.whatsapp.instanceId = 'test-instance';
    cfg.whatsapp.token = 'fake-token';
    cfg.whatsapp.apiUrl = 'https://api.ultramsg.com';
    const msg = voiceMsg();
    delete msg.data.link; // the incident payload shape
    assert.equal((await webhook(msg)).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
    // and the diag row shows the link was FOUND via the fallback this time
    const { VoiceDiag } = await import('../backend/models/index.js');
    const diag = await VoiceDiag.findOne({ channel: 'teacher' }).sort({ createdAt: -1 }).lean();
    assert.equal(diag.urlFound, true);
    assert.equal(diag.engine, 'gemini');
    assert.ok(!diag.error, `no error this time: ${diag.error}`);
  } finally {
    geminiVoiceTranscript = null;
    cfg.whatsapp.instanceId = had.id;
    cfg.whatsapp.token = had.token;
    cfg.whatsapp.apiUrl = had.url;
  }
});

test('OWNER night #8 VOICE NOTES: a spoken YES confirms the class — the transcript runs the exact same pipeline', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-16', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  voiceTranscript = 'YES'; // Whisper heard a plain YES
  try {
    assert.equal((await webhook(voiceMsg())).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
    // a spoken question answers like a typed one
    const r2 = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-17', startTime: '09:00', endTime: '10:00' });
    geminiAnswer = 'QUESTION';
    geminiChatReply = 'Sir, class 9:00 AM se 10:00 AM tak hai. Kya aap ye class lein ge, Sir?';
    voiceTranscript = 'time kia hai?';
    const before = sent.length;
    assert.equal((await webhook(voiceMsg())).json.data.updated, true);
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1).body, geminiChatReply);
    assert.equal((await Timetable.findById(r2.json.data._id)).teacherConfirmation.status, 'awaiting');
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed'); // part 1 decision intact
  } finally {
    voiceTranscript = null; geminiAnswer = null; geminiChatReply = null;
  }
});

test('OWNER 2026-10-08 VOICE DIAG: silent transcription failure is now VISIBLE in VoiceDiag + voice-log endpoint', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-22', startTime: '09:00', endTime: '10:00' });
  voiceTranscript = null; geminiVoiceTranscript = null; // every engine fails
  try {
    assert.equal((await webhook(voiceMsg())).json.data.updated, false); // still silent to the teacher
    const { VoiceDiag } = await import('../backend/models/index.js');
    const diag = await VoiceDiag.findOne({ channel: 'teacher' }).sort({ createdAt: -1 }).lean();
    assert.ok(diag, 'diag row recorded');
    assert.equal(diag.phone, '923001112233');
    assert.equal(diag.urlFound, true); // the link was in the payload
    assert.ok(diag.error, `failure reason captured: ${diag.error}`);
    // the owner-only diagnostic endpoint returns the row (sweep secret required)
    const sec = process.env.DEADLINE_SWEEP_SECRET;
    const res = await fetch(`${base}/api/whatsapp/voice-log?secret=${sec}`);
    assert.equal(res.status, 200);
    const rows = (await res.json()).data;
    assert.ok(rows.some((row) => row.channel === 'teacher' && row.error));
    const denied = await fetch(`${base}/api/whatsapp/voice-log?secret=wrong`);
    assert.equal(denied.status, 401);
  } finally {
    voiceTranscript = null;
  }
});

test('OWNER night #8 VOICE NOTES: transcription failure is SILENT — never guessed, nothing breaks', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-18', startTime: '09:00', endTime: '10:00' });
  voiceTranscript = null; // Whisper unavailable
  const before = sent.length;
  try {
    assert.equal((await webhook(voiceMsg())).json.data.updated, false);
    assert.equal(sent.length, before);
    assert.equal((await Timetable.findById(r.json.data._id)).teacherConfirmation.status, 'awaiting');
  } finally {
    voiceTranscript = null;
  }
});

test('OWNER night #8 PER-TEACHER MEMORY: the language detector learns from the teacher\u2019s own messages and the prompt mirrors it', async () => {
  const { detectChatLanguage } = await import('../backend/services/teacherConfirmationService.js');
  assert.equal(detectChatLanguage('han ma class loon ga'), 'roman_urdu');
  assert.equal(detectChatLanguage('What time is the class today?'), 'english');
  assert.equal(detectChatLanguage('\\u06a9\\u0644\\u0627\\u0633 \u06a9\\u0628 \u06c1\\u06d2'), 'urdu');
  assert.equal(detectChatLanguage('ok'), null);
  assert.equal(detectChatLanguage(''), null);

  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  const liveTeacher = await Teacher.findOne({ section, subject });
  assert.ok(liveTeacher, 'current teacher doc exists');
  await Teacher.updateOne({ _id: liveTeacher._id }, { $set: { 'chatProfile.romanCount': 0, 'chatProfile.englishCount': 0, 'chatProfile.detectedLanguage': null } });
  await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-19', startTime: '09:00', endTime: '10:00' });

  geminiAnswer = 'QUESTION';
  try {
    // message 1: roman urdu — not enough evidence yet, no profile line in the prompt
    geminiChatReply = 'Sir, 9:00 AM. Kya aap class lein ge, Sir?';
    await webhook(incoming('han sir time bata dein class ka'));
    let prof = (await Teacher.findById(liveTeacher._id)).chatProfile;
    assert.equal(prof.romanCount, 1);
    // message 2: roman urdu again — the profile is now DETECTED and the chat prompt mirrors it
    const classifyBefore = geminiBodies.length;
    await webhook(incoming('acha room konsa hai phir bata dein'));
    prof = (await Teacher.findById(liveTeacher._id)).chatProfile;
    assert.equal(prof.romanCount, 2);
    assert.equal(prof.detectedLanguage, 'roman_urdu');
    const chatCall = geminiBodies.slice(classifyBefore).find((b) => b.body.includes('"reply"'));
    assert.match(chatCall.body, /Teacher's usual language: Roman Urdu/);
  } finally {
    geminiAnswer = null; geminiChatReply = null;
  }
});

test('OWNER MASTER SPEC §13 (night #7) ACCEPTANCE: FIVE rapid questions in a row ALL get answers, then a real YES confirms — the conversation never goes silent', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-10', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  geminiAnswer = 'QUESTION';
  const answers = {
    'time kia hai?': 'Sir, class 9:00 AM se 10:00 AM tak hai.',
    'section konsa hai?': 'Sir, ye 4B section hai.',
    'room?': 'Sir, class R2 mein scheduled hai.',
    'CR kon hai?': 'Sir, is section ke CR Abdul Rehman hain.',
    'cr ka number?': 'Sir, CR ka number 03088787753 hai.',
  };
  const asked = [];
  try {
    // back-to-back questions, NO cooldown unlocking — every one must answer
    for (const [q, a] of Object.entries(answers)) {
      geminiChatReply = a;
      const before = sent.length;
      assert.equal((await webhook(incoming(q))).json.data.updated, true, `must respond to: ${q}`);
      assert.equal(sent.length, before + 1, `exactly one reply to: ${q}`);
      assert.equal(sent.at(-1).body, a);
      asked.push(q);
      assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
    }
    // 'ok' → asks for the real decision (never confirms)
    const before = sent.length;
    geminiAnswer = 'ACK';
    assert.equal((await webhook(incoming('ok'))).json.data.updated, true);
    assert.equal(sent.length, before + 1);
    assert.match(sent.at(-1).body, /lein ge|conduct karein|confirm/i);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
    // clear YES → CONFIRMED, loop ends
    geminiAnswer = null;
    assert.equal((await webhook(incoming('han ma class loon ga'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }
});

test('OWNER MASTER SPEC §13 (night #7) ACCEPTANCE (decline path): questions keep flowing, then a clear NO declines', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-11', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  geminiAnswer = 'QUESTION';
  try {
    for (const q of ['time kia hai?', 'room?', 'kis ny class schedule ki?']) {
      geminiChatReply = `Sir — jawab: ${q}`;
      const before = sent.length;
      assert.equal((await webhook(incoming(q))).json.data.updated, true, `must respond to: ${q}`);
      assert.equal(sent.length, before + 1);
      assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
    }
    // 'no bas itna hi' → NO MORE QUESTIONS, not a decline (§21/§6)
    geminiAnswer = 'ACK';
    const before = sent.length;
    assert.equal((await webhook(incoming('no bas itna hi'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
    assert.ok(sent.length >= before);
    // clear NO → DECLINED
    geminiAnswer = null;
    assert.equal((await webhook(incoming('nahi sir ma class nahi loon ga'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'declined');
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }
});

test('OWNER MASTER SPEC §10 (night #7): duplicate webhook DELIVERY of the SAME message id is answered exactly ONCE (dedupe by id, never by time)', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-12', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  geminiAnswer = 'QUESTION';
  geminiChatReply = 'Sir, class 9:00 AM se 10:00 AM tak hai.';
  try {
    const dup = incoming('time kia hai?');
    const before = sent.length;
    assert.equal((await webhook(dup)).json.data.updated, true);
    assert.equal(sent.length, before + 1);
    // the SAME webhook payload delivered twice (network retry) → no second reply
    const second = await webhook(dup);
    assert.equal(sent.length, before + 1, 'duplicate id must not re-reply');
    // a NEW message id with the SAME text still gets a fresh answer
    assert.equal((await webhook(incoming('time kia hai?'))).json.data.updated, true);
    assert.equal(sent.length, before + 2);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }
});

test('OWNER MASTER SPEC §22-C (night #6): an information answer while PENDING always carries the confirmation ask — never a bare answer', async () => {
  const { buildStaticTeacherAnswer, buildQuestionAnswerMessage } = await import('../backend/services/teacherConfirmationService.js');
  // offline one-topic answer (API down): answer + ask in the same message
  const one = buildStaticTeacherAnswer('class kitny bajy hai?', { section: '2M', department: 'AI', semester: 2,
    subject: 'SS', day: 'Thu', time: '9:00 AM', room: 'Clerk Office', crName: 'Abdul Rehman', crRole: 'CR',
    crPhone: '03088787753', classStatus: 'awaiting' });
  assert.match(one, /9:00 AM/);            // the question was answered
  assert.match(one, /Kya aap ye scheduled class lein ge, Sir\?/); // AND the ask follows (§22-C)
  // full card while awaiting: also asks
  const card = buildQuestionAnswerMessage({ section: '2M', department: 'AI', semester: 2, subject: 'SS',
    day: 'Thu', time: '9:00 AM', room: 'Clerk Office', crName: 'Abdul Rehman', crRole: 'CR',
    crPhone: '03088787753', classStatus: 'awaiting' });
  assert.match(card, /Kya aap ye scheduled class lein ge, Sir\?/);
  // decided classes never re-ask
  const done = buildStaticTeacherAnswer('class kitny bajy hai?', { section: '2M', department: 'AI', semester: 2,
    subject: 'SS', day: 'Thu', time: '9:00 AM', room: 'Clerk Office', crName: 'Abdul Rehman', crRole: 'CR',
    crPhone: '03088787753', classStatus: 'confirmed' });
  assert.doesNotMatch(done, /Kya aap ye scheduled class lein ge/);
});

test('OWNER MASTER SPEC §21 (night #5): "nahi koi detail nahi chahiye" is NOT a decline — the class stays PENDING until a real decision', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-30', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  // teacher asks who this is, then says they don't need details
  geminiAnswer = 'QUESTION';
  geminiChatReply = 'Wa Alaikum Assalam Sir. Main Tri3M Class Agent hoon, class coordination assistant. Aapki scheduled class ke reminder ke liye contact kar raha hoon. Agar koi aur detail chahiye to bataiyega.';
  try {
    assert.equal((await webhook(incoming('ap kon ho?'))).json.data.updated, true);

    // "nahi koi detail nahi chahiye" — NO MORE QUESTIONS, NOT a decline (§21-A)
    assert.equal((await webhook(incoming('nahi koi detail nahi chahiye'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
    const ask = sent.at(-1);
    assert.match(ask.body, /lein ge|will you be taking|confirm|conduct karein/i); // warm confirm-ask
    assert.doesNotMatch(ask.body, /unavailable|decline/i);

    // a real YES now confirms (§21-E) — fresh classification, rules say YES
    geminiAnswer = null;
    assert.equal((await webhook(incoming('han sir class loon ga'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }
});

test('OWNER MASTER SPEC §21-C/G: a bare "nahi" AFTER THE CLASS QUESTION declines, but after a plain answer it just asks again', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-31', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  // CASE 1: the agent's last turn was the class-question ask → bare 'nahi' = DECLINE (§21-G)
  assert.equal((await webhook(incoming('ok'))).json.data.updated, true); // ack → confirm-ask (agent turn asks the class question)
  assert.equal((await webhook(incoming('nahi'))).json.data.updated, true);
  assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'declined');
  assert.match(sent.at(-1).body, /unavailable|decline|understood/i); // decline ack
});

test('OWNER MASTER SPEC §21-F: bare "nahi" right after a NON-question agent answer means no-more-questions — class stays PENDING', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-02-03', startTime: '14:00', endTime: '15:00' });
  const slotId = r.json.data._id;

  geminiAnswer = 'QUESTION';
  // an answer with NO class-ask in it (agent offered details)
  geminiChatReply = 'Sir, is class ka CR Abdul Rehman Bin Abdullah hai. Aur koi detail chahiye to bataiyega.';
  try {
    assert.equal((await webhook(incoming('cr kon hai?'))).json.data.updated, true);

    // bare 'nahi' answers "aur detail chahiye?" → no-more-questions, NOT a decline (§21-C/G)
    geminiAnswer = null; // fresh classification of the bare 'nahi' (rules path)
    assert.equal((await webhook(incoming('nahi'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting');
    assert.match(sent.at(-1).body, /lein ge|will you be taking|confirm|conduct karein/i); // asks for the real decision
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }
});

test('OWNER MASTER SPEC §4/§18: multi-turn conversation memory — turns recorded on the slot and replayed to the LLM', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-28', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  geminiAnswer = 'QUESTION';
  geminiChatReply = 'Sir, the CR for this class is Alex Representative.';
  try {
    // turn 1: a question
    assert.equal((await webhook(incoming('cr kon hai?'))).json.data.updated, true);

    // turn 2: a SHORT follow-up — 'number?' only makes sense with the context
    geminiChatReply = 'His contact number is +923009876543, Sir.';
    assert.equal((await webhook(incoming('number?'))).json.data.updated, true);

    const conv = (await Timetable.findById(slotId)).teacherConfirmation.conversation;
    assert.equal(conv.length, 4);                        // teacher, agent, teacher, agent
    assert.equal(conv[0].role, 'teacher');
    assert.match(conv[0].text, /cr kon hai/);
    assert.equal(conv[1].role, 'agent');
    assert.match(conv[1].text, /Alex Representative/);
    assert.equal(conv[2].role, 'teacher');
    assert.match(conv[2].text, /number/);

    // the second LLM call actually RECEIVED the earlier turns (multi-turn prompt)
    const chatCalls = geminiBodies.filter((c) => c.body.includes('"reply"'));
    assert.ok(chatCalls.length >= 2);
    assert.ok(chatCalls.at(-1).body.includes('RECENT CONVERSATION'));
    assert.ok(chatCalls.at(-1).body.includes('cr kon hai?'));
    assert.ok(chatCalls.at(-1).body.includes('Alex Representative')); // the agent's own turn too

    // turn 3: the YES answer lands in the same conversation memory
    assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
    const conv2 = (await Timetable.findById(slotId)).teacherConfirmation.conversation;
    assert.equal(conv2.at(-2).role, 'teacher');
    assert.match(conv2.at(-2).text, /^YES$/);
    assert.equal(conv2.at(-1).role, 'agent'); // the thank-you ack is recorded too
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }
});

test('OWNER BUG FIX (2026-10-07 night #2): "ye kis ka number hai?" → honest identity answer, NEVER the canned confusion hint', async () => {
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp,
    'teacherConfirmation.status': 'awaiting' }, { $set: { 'teacherConfirmation.status': 'declined' } });
  const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-27', startTime: '09:00', endTime: '10:00' });
  const slotId = r.json.data._id;

  // all models down (geminiAnswer/geminiChatReply null) → static identity intro
  assert.equal((await webhook(incoming('ye kis ka number hai?'))).json.data.updated, true);
  assert.match(sent.at(-1).body, /AI class-coordination assistant|Tri3M Class Agent/);
  assert.match(sent.at(-1).body, /Alex Representative/);
  assert.doesNotMatch(sent.at(-1).body, /Sorry for the confusion/);

  // Gemini misreads the question as UNCLEAR → still a conversation, never the hint
  geminiAnswer = 'UNCLEAR';
  geminiChatReply = 'Sir, ye Tri3M Class Agent ka number hai — aap ke section CR ke taraf se class confirm karne ke liye. Kindly YES ya NO bata dein.';
  try {
    assert.equal((await webhook(incoming('ye kis ka number hai?'))).json.data.updated, true);
    assert.equal(sent.at(-1).body, geminiChatReply);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'awaiting'); // nothing confirmed
  } finally {
    geminiAnswer = null;
    geminiChatReply = null;
  }

  // a genuine maybe (no question shape) keeps the polite hint — correct behavior
  geminiAnswer = 'UNCLEAR';
  try {
    assert.equal((await webhook(incoming('shayad bata donga'))).json.data.updated, true);
    assert.match(sent.at(-1).body, /YES \*or\* \*NO|plain \*YES\* or \*NO/i);
  } finally {
    geminiAnswer = null;
  }
});

test('hint reminders rotate through a pool so repeats never read identical', async () => {
  const { buildHintMessage } = await import('../backend/services/teacherConfirmationService.js');
  const pool = new Set(Array.from({ length: 40 }, () => buildHintMessage('Dr Test')));
  assert.ok(pool.size >= 3, `hint pool should rotate across variants (got ${pool.size})`);
  for (const body of pool) {
    assert.match(body, /plain \*YES\* or \*NO\*/);
    assert.match(body, /\*Dr Test\*/);
    assert.match(body, /— Tri3M Class Agent/);
    // OWNER 2026-10-07: human tone — no robot talk, no canned team/offline text
    assert.doesNotMatch(body, /AI (agent|assistant)|automated|offline|team|support/i);
  }
});

/* ============== OWNER night #8 follow-up: EXPERIENCE LIBRARY (DB) ============= */

test('experience library: admin routes are admin-only and stats have the right shape', async () => {
  const anon = await fetch(`${base}/api/admin/experience`);
  assert.equal(anon.status, 401);
  const res = await admin('GET', '/api/admin/experience');
  assert.equal(res.status, 200);
  const d = res.json.data;
  assert.ok(d.classify && typeof d.classify.seed === 'number' && typeof d.classify.real === 'number');
  assert.ok(d.chat && typeof d.chat.seed === 'number' && typeof d.chat.real === 'number');
  assert.ok('lastRefreshAt' in d);
});

test('experience library: refresh mines REAL conversation pairs and dedupes on rerun', async () => {
  const { ExperienceExample } = models;
  await ExperienceExample.deleteMany({ source: 'real' });

  // a real exchange: an interpreted YES ack proves the verdict
  const slot = await Timetable.findOne({ section });
  await Timetable.updateOne({ _id: slot._id }, {
    $push: { 'teacherConfirmation.conversation': [
      { role: 'teacher', text: 'mera dil nahi kar raha par aap request karo', at: new Date() },
      { role: 'agent', text: `Thank you, Dr Test! I understood your reply as a *YES*. ✅`, at: new Date() },
    ] },
  });
  await Timetable.updateOne({ _id: slot._id }, { $set: { updatedAt: new Date() } });

  const res = await admin('POST', '/api/admin/experience/refresh');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.pairsScanned >= 1, 'the pushed pair was scanned');
  assert.ok(res.json.data.chatAdded >= 1, 'chat example stored');
  assert.ok(res.json.data.classifyAdded >= 1, 'classify example stored');

  // the real pair landed verbatim, with the PROVEN verdict
  const chatEx = await ExperienceExample.findOne({ kind: 'chat', source: 'real',
    input: 'mera dil nahi kar raha par aap request karo' });
  assert.ok(chatEx, 'chat example for the pushed pair exists');
  assert.match(chatEx.output, /understood your reply as a \*YES\*/);
  const clsEx = await ExperienceExample.findOne({ kind: 'classify', source: 'real',
    input: 'mera dil nahi kar raha par aap request karo' });
  assert.ok(clsEx, 'classify example for the pushed pair exists');
  assert.equal(clsEx.output, 'YES');

  // stats reflect it
  const stats = (await admin('GET', '/api/admin/experience')).json.data;
  assert.ok(stats.chat.real >= Math.min(res.json.data.chatAdded, 30), 'real chat examples visible (cap: 30 active)');
  assert.ok(stats.classify.real >= Math.min(res.json.data.classifyAdded, 30));

  // rerun is idempotent — dedupeKey blocks duplicates
  const again = await admin('POST', '/api/admin/experience/refresh');
  assert.equal(again.status, 200);
  assert.equal(again.json.data.chatAdded, 0, 'same pair never stored twice');
  assert.equal(again.json.data.classifyAdded, 0);
  assert.equal((await ExperienceExample.countDocuments({ source: 'real' })).toString(),
    (res.json.data.chatAdded + res.json.data.classifyAdded).toString());
});

test('experience library: refreshed real examples flow into the classifier prompt', async () => {
  geminiBodies.length = 0;
  await Timetable.updateMany({ section, 'teacherConfirmation.phone': teacher.whatsapp }, { $set: { 'teacherConfirmation.status': 'none' } });
  await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-16', startTime: '09:00', endTime: '10:00' });
  geminiAnswer = 'UNCLEAR';
  try {
    await webhook(incoming('kiya kar rahe ho'));
    const lastClassify = geminiBodies.filter((b) => !b.body.includes('"reply"')).at(-1);
    assert.ok(lastClassify, 'classify call happened');
    assert.match(lastClassify.body, /mera dil nahi kar raha par aap request karo/); // REAL example injected
    assert.match(lastClassify.body, /YES/); // with its proven verdict
  } finally {
    geminiAnswer = null;
  }
});

test('experience library: refresh never trains a verdict it cannot prove', async () => {
  const { ExperienceExample } = models;
  const slot = await Timetable.findOne({ section });
  await Timetable.updateOne({ _id: slot._id }, {
    $push: { 'teacherConfirmation.conversation': [
      { role: 'teacher', text: 'acha theek hai', at: new Date() },
      { role: 'agent', text: 'Sir, agar aapko koi aur masla ho to zaroor batayein.', at: new Date() },
    ] },
  });
  await Timetable.updateOne({ _id: slot._id }, { $set: { updatedAt: new Date() } });

  const res = await admin('POST', '/api/admin/experience/refresh');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.chatAdded >= 1, 'chat example still learned (style)');
  // 'acha theek hai' has no provable verdict -> NO classify example for it
  const cls = await ExperienceExample.findOne({ kind: 'classify', source: 'real', input: 'acha theek hai' });
  assert.equal(cls, null);
});

test.after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongod.stop();
});
