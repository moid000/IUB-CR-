/**
 * OWNER SPEC 2026-10-11 — PROFESSIONAL SHORT CR NOTIFICATIONS + CLEAN
 * WHATSAPP FORMATTING. Real services, real webhook route, real DB models:
 *   1. Published Notes upload → the CR gets ONE short professional message
 *      (owner example shape), tracked with a provider message id.
 *   2. Teacher question → ONE short owner-format alert with teacher name,
 *      the original question, and the Q-code — readable mobile lines.
 *   3. Duplicate webhook + sweep rerun → the CR NEVER gets a second copy
 *      (outbox dedupe by event refKey).
 *   4. Failed CR ping → status stays pending, the sweep retries it ONCE —
 *      no duplicate when it succeeds, teacher/CR never told it failed-succeeded.
 *   5. sanitizer unit cases: literal \n, double spaces, 3+ blank lines,
 *      undefined labels, HTML, markdown fences, footer, word joining.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('cr_notify_test');
process.env.JWT_SECRET = 'test-cr-notify-jwt';
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
const { Note, Section, Subject, Teacher, TeacherMaterial, TeacherQuestion, User, OutboxMessage, Notification } = models;
const { escalateTeacherQuestion, runTeacherQuestionSweep } =
  await import('../backend/services/teacherQuestionService.js');
const { runTeacherMaterialSweep } = await import('../backend/services/teacherMaterialService.js');
const { sanitizeWhatsAppText, cleanWhatsAppField } = await import('../backend/services/whatsappService.js');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const sent = [];
let geminiClassify = null;
let geminiApproval = null;
let failSendsTo = null; // simulate gateway failures for a specific recipient

globalThis.fetch = (url, options) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com')) {
    const body = String(options.body);
    const geminiText = (obj) => new Response(JSON.stringify(
      { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });
    if (body.includes('"study_material"')) {
      return Promise.resolve(geminiClassify ? geminiText(geminiClassify) : new Response(JSON.stringify({}), { status: 400 }));
    }
    if (body.includes('"upload"') || (body.includes('"answer"') && body.includes('approve'))) {
      return Promise.resolve(geminiApproval ? geminiText(geminiApproval) : new Response(JSON.stringify({}), { status: 400 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 400 }));
  }
  if (u.includes('cdn.example')) {
    const name = decodeURIComponent(u.split('/').pop() ?? 'x');
    const bytes = [37, 80, 68, 70, 1, 2, 3, ...[...name].map((c) => c.charCodeAt(0) % 251)];
    return Promise.resolve(new Response(new Uint8Array(bytes).buffer, { status: 200 }));
  }
  if (u.includes('api.cloudinary.com')) {
    const folder = options.body.get('folder');
    const publicId = options.body.get('public_id');
    return Promise.resolve(new Response(JSON.stringify({
      public_id: `${folder}/${publicId}.pdf`, secure_url: `https://res.cloudinary.com/demo/${folder}/${publicId}.pdf`,
      bytes: 1234, format: '', resource_type: 'raw' }), { status: 200 }));
  }
  if (u.includes('api.ultramsg.com/test-instance/messages/chat')) {
    const data = new URLSearchParams(options.body);
    const to = data.get('to');
    if (failSendsTo && String(to).includes(failSendsTo)) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'gateway down', sent: false }), { status: 503 }));
    }
    sent.push({ to, body: data.get('body') });
    return Promise.resolve(new Response(JSON.stringify({ sent: true, msgId: `wa-${sent.length}` }), { status: 200 }));
  }
  if (/api\.ultramsg\.com\/test-instance\/messages\/(document|image|audio|video)/.test(u)) {
    const data = new URLSearchParams(options.body);
    sent.push({ to: data.get('to'), body: `[${u.split('/').pop()} ${data.get('caption') ?? ''}]` });
    return Promise.resolve(new Response(JSON.stringify({ sent: true }), { status: 200 }));
  }
  return realFetch(url, options);
};

const { default: app } = await import('../backend/app.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const session = () => {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json() };
  };
};
const admin = session();
const webhook = (body) => admin('POST', '/api/whatsapp/teacher-reply?key=fake-webhook-secret', body);

const TEACHER = '923001112233';
const CR = '923009876543';
const fileMsg = ({ filename, caption = '', id }) => ({
  event_type: 'message_received', instanceId: 'test-instance',
  data: { id: id ?? `file-${Math.random()}`, from: `${TEACHER}@c.us`, fromMe: false, type: 'document',
    filename, mimetype: 'application/pdf', caption, media: `https://cdn.example/${encodeURIComponent(filename)}`,
    time: Math.floor(Date.now() / 1000) } });
const replyMsg = (text, id) => ({
  event_type: 'message_received', instanceId: 'test-instance',
  data: { id: id ?? `reply-${Math.random()}`, from: `${TEACHER}@c.us`, fromMe: false, type: 'chat',
    body: text, time: Math.floor(Date.now() / 1000) } });

let section, subject, teacher, crUser;
test.before(async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const academicSession = (await admin('POST', '/api/admin/sessions', { name: '2099–2100' })).json.data._id;
  section = (await admin('POST', '/api/admin/sections', { department: dept, session: academicSession, semester: 4, name: '4B' })).json.data._id;
  subject = (await admin('POST', '/api/admin/subjects', { section, name: 'Data Structures', code: 'DS-101' })).json.data._id;
  const hash = await bcrypt.hash('TeacherTest123!', 10);
  crUser = await User.create({ name: 'Alex Representative', email: 'cr-notify@test.local', phone: '+923009876543',
    role: 'cr', section, registrationStatus: 'active', emailVerified: true, password: hash });
  await Section.updateOne({ _id: section }, { $set: { cr: crUser._id } });
  teacher = await Teacher.create({ name: 'Dr Test', subject, section, whatsapp: TEACHER, createdBy: crUser._id });
});
test.after(async () => {
  await mongoose.disconnect();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  await mongod.stop();
});
test.afterEach(async () => {
  geminiClassify = null; geminiApproval = null; failSendsTo = null;
  await TeacherMaterial.deleteMany({}); await Note.deleteMany({}); await TeacherQuestion.deleteMany({});
  await OutboxMessage.deleteMany({}); await Notification.deleteMany({});
  await Teacher.updateMany({}, { $set: { conversation: [], lastChatMsgId: '' } });
});

const crMsgs = (from = 0) => sent.slice(from).filter((s) => s.to === CR);

/* ------------------------- sanitizer unit cases ------------------------- */

test('SANITIZE: keeps real newlines, kills literal \\n, double spaces, dead labels, HTML, markdown, footer — never joins words', () => {
  const out = sanitizeWhatsAppText('Sir, English ke notes\\n\\n\\n\\nupload ho gaye hain.  Ek baar  check kar lein.\\nSubject: undefined\\nSection: null\\n```json {"x":1}``` <b>bold</b>\\n— Tri3M Class Agent');
  assert.match(out, /Sir, English ke notes\n\nupload ho gaye hain\. Ek baar check kar lein\./, 'words stay spaced, max one blank line');
  assert.doesNotMatch(out, /undefined|null/, 'dead label values dropped');
  assert.doesNotMatch(out, /```|\{"x":1\}|<b>/, 'markdown/JSON/HTML stripped');
  assert.doesNotMatch(out, /Tri3M Class Agent/, 'footer removed');
  assert.doesNotMatch(out, /notesupload/, 'words are never concatenated');
  // literal escaped newline TEXT becomes a real break
  assert.ok(sanitizeWhatsAppText('line one\\nline two').includes('\n'), 'literal \\n becomes a newline');
  // single spaces between words preserved — no over-collapsing
  assert.equal(sanitizeWhatsAppText('hello   world'), 'hello world');
  assert.equal(sanitizeWhatsAppText('  \n\n\n  spaced  \n\n\n out  '), 'spaced\n\nout');
});

test('SANITIZE FIELD: names/questions get single-line, no machine text, capped', () => {
  assert.equal(cleanWhatsAppField('Dr  Ali\nKhan'), 'Dr Ali Khan');
  assert.equal(cleanWhatsAppField('undefined'), '');
  assert.equal(cleanWhatsAppField('{"err":"boom"}').includes('err'), false);
  assert.equal(cleanWhatsAppField('x'.repeat(300), 120).length, 120);
});

/* ------------------- published Notes upload → CR message ------------------ */

test('CR-1: published Notes upload → ONE short owner-format CR message, tracked with provider msg id', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  const before = sent.length;
  await webhook(fileMsg({ filename: 'Ch3_Notes.pdf', id: 'cr-notify-1' }));
  geminiApproval = { answer: 'approve' };
  await webhook(replyMsg('haan kar do', 'cr-notify-yes'));
  const pubs = crMsgs(before).filter((m) => /portal par upload kiye hain/i.test(m.body));
  assert.equal(pubs.length, 1, 'exactly ONE published CR message');
  const body = pubs[0].body;
  assert.match(body, /Sir, Dr Test ne Data Structures ke notes portal par upload kiye hain\./, 'owner example first line with teacher');
  assert.match(body, /Section: 4B/, 'verified section on its own line');
  assert.match(body, /Ek baar check kar lein\./, 'short action line');
  assert.doesNotMatch(body, /Assalam-o-Alaikum|Tri3M update|successfully UPLOAD|verified\./i, 'old verbose wording gone');
  assert.doesNotMatch(body, /— Tri3M Class Agent/, 'no footer');
  assert.ok(body.length < 220, 'short message, not a paragraph');
  // delivery bookkeeping: status + provider msg id stored
  const mat = await TeacherMaterial.findOne({ waMsgId: 'cr-notify-1' }).lean();
  assert.equal(mat.crNotify.status, 'delivered');
  assert.equal(mat.crNotify.event, 'published');
  const rows = await OutboxMessage.find({ refKey: `cr-notify:${mat._id}:published` }).lean();
  assert.equal(rows.length, 1, 'one outbox row for the event');
  assert.equal(rows[0].status, 'sent');
  assert.ok(rows[0].providerMsgId, 'provider message id persisted');
});

test('CR-2: duplicate webhook + sweep rerun → the CR never gets a second copy', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  const before = sent.length;
  const evt = fileMsg({ filename: 'Dup_Notes.pdf', id: 'cr-dup-1' });
  await webhook(evt);
  geminiApproval = { answer: 'approve' };
  await webhook(replyMsg('haan kar do', 'cr-dup-yes'));
  await webhook(replyMsg('haan kar do', 'cr-dup-yes')); // approval redelivery
  await runTeacherMaterialSweep(); // sweep pass — nothing to resend
  await runTeacherMaterialSweep();
  assert.equal(crMsgs(before).filter((m) => /portal par upload kiye hain/i.test(m.body)).length, 1,
    'ONE published CR message across redeliveries AND sweeps');
  assert.equal(await Note.countDocuments({}), 1, 'one note');
});

test('CR-3: failed CR ping → pending status, sweep retries ONCE, no duplicates, no false claims', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  const before = sent.length;
  failSendsTo = CR; // the gateway rejects CR-bound sends this pass
  await webhook(fileMsg({ filename: 'Retry_Notes.pdf', id: 'cr-retry-1' }));
  geminiApproval = { answer: 'approve' };
  await webhook(replyMsg('haan kar do', 'cr-retry-yes'));
  failSendsTo = null;
  const mat0 = await TeacherMaterial.findOne({ waMsgId: 'cr-retry-1' }).lean();
  assert.equal(mat0.crNotify.status, 'pending', 'honestly marked pending — never claimed delivered');
  const teacherConfirm = sent.slice(before).filter((s) => s.to === TEACHER && /upload ho gaye hain/.test(s.body));
  assert.match(teacherConfirm[0].body, /retry kar raha hoon/i, 'teacher told the CR ping is pending');
  // age the retry clock so the sweep's CR retry is due
  await TeacherMaterial.updateOne({ waMsgId: 'cr-retry-1' },
    { $set: { 'crNotify.lastTriedAt': new Date(Date.now() - 6 * 60 * 1000) } });
  await runTeacherMaterialSweep();
  const pubs = crMsgs(before).filter((m) => /portal par upload kiye hain/i.test(m.body));
  assert.equal(pubs.length, 1, 'sweep delivered the CR ping exactly once');
  const mat = await TeacherMaterial.findOne({ waMsgId: 'cr-retry-1' }).lean();
  assert.equal(mat.crNotify.status, 'delivered', 'status now delivered');
  await runTeacherMaterialSweep();
  assert.equal(crMsgs(before).filter((m) => /portal par upload kiye hain/i.test(m.body)).length, 1, 'no duplicate on the next sweep');
});

/* --------------------- teacher question → CR alert ----------------------- */

test('CR-4: teacher question → short owner-format alert with teacher name, original question, Q-code; duplicates impossible', async () => {
  const before = sent.length;
  const t1 = await escalateTeacherQuestion({ sender: TEACHER, payload: replyMsg('Sir, kal ki class kis room mein hai?'),
    teacherDoc: teacher, sectionId: section, crDoc: crUser, question: 'kal ki class kis room mein hai?' });
  assert.equal(t1.reused, false);
  const alerts = crMsgs(before).filter((m) => /ka sawal hai:/.test(m.body));
  assert.equal(alerts.length, 1, 'ONE question alert');
  const body = alerts[0].body;
  assert.match(body, /Sir, Dr Test ka sawal hai:/, 'teacher named');
  assert.match(body, /"kal ki class kis room mein hai\?"\s*\(Q-/, 'original question + Q-code');
  assert.match(body, /Jab mumkin ho, jawab de dein\./, 'short action line');
  assert.doesNotMatch(body, /Assalam-o-Alaikum|confirmed nahi kar sakta|Tri3M Class Agent/, 'old verbose wording + footer gone');
  assert.ok(body.split('\n').every((l) => l.length < 120), 'readable mobile lines');
  const task = await TeacherQuestion.findOne({}).lean();
  assert.equal(task.crNotifiedAt != null, true, 'delivery state persisted');
  const rows = await OutboxMessage.find({ refKey: `q-dispatch:${task._id}` }).lean();
  assert.equal(rows.length, 1);
  assert.ok(rows[0].providerMsgId, 'provider msg id stored');
  // a second escalation of the SAME unresolved question reuses the task — no new CR message
  const again = await escalateTeacherQuestion({ sender: TEACHER, payload: replyMsg('kal ki class kis room mein hai? (repeat)'),
    teacherDoc: teacher, sectionId: section, crDoc: crUser, question: 'kal ki class kis room mein hai?' });
  assert.equal(again.reused, true, 'same question reuses the task');
  assert.equal(crMsgs(before).filter((m) => /ka sawal hai:/.test(m.body)).length, 1, 'still ONE alert');
  // sweep passes never duplicate the dispatch
  await runTeacherQuestionSweep();
  await runTeacherQuestionSweep();
  assert.equal(crMsgs(before).filter((m) => /ka sawal hai:/.test(m.body)).length, 1, 'no duplicate across sweeps');
});

test('CR-5: CR reminder (unanswered question) → short, ONE, never repeated', async () => {
  const before = sent.length;
  await escalateTeacherQuestion({ sender: TEACHER, payload: replyMsg('mid-term kis din hai?'),
    teacherDoc: teacher, sectionId: section, crDoc: crUser, question: 'mid-term kis din hai?' });
  const task = await TeacherQuestion.findOne({ question: /mid-term/ }).lean();
  await TeacherQuestion.updateOne({ _id: task._id },
    { $set: { askedAt: new Date(Date.now() - 60 * 60 * 1000) } }); // an hour old
  await runTeacherQuestionSweep();
  const reminders = crMsgs(before).filter((m) => /abhi pending hai:/.test(m.body));
  assert.equal(reminders.length, 1, 'exactly ONE reminder');
  assert.match(reminders[0].body, /Sir, Dr Test ka sawal abhi pending hai:/);
  assert.match(reminders[0].body, /Jab mumkin ho, jawab de dein\./);
  await runTeacherQuestionSweep(); // next pass — reminderSent claim holds
  assert.equal(crMsgs(before).filter((m) => /abhi pending hai:/.test(m.body)).length, 1, 'never a second reminder');
});

/* --------------------------- message hygiene ---------------------------- */

test('CR-6: NO CR-facing message ever contains code, JSON, stack traces, or raw errors', async () => {
  const before = sent.length;
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  await webhook(fileMsg({ filename: 'Clean_Notes.pdf', id: 'cr-clean-1' }));
  geminiApproval = { answer: 'approve' };
  await webhook(replyMsg('haan kar do', 'cr-clean-yes'));
  await escalateTeacherQuestion({ sender: TEACHER, payload: replyMsg('assignment ki due date kya hai?'),
    teacherDoc: teacher, sectionId: section, crDoc: crUser, question: 'assignment ki due date kya hai?' });
  for (const m of crMsgs(before)) {
    assert.doesNotMatch(m.body, /\{|\}|=>|function|Traceback|at \/|TypeError|Error:|undefined|NaN|\\n|&lt;|&gt;/,
      `no machine text in CR message: ${m.body.slice(0, 80)}`);
    assert.doesNotMatch(m.body, /  +/, 'no accidental double spaces');
    assert.ok(m.body.split('\n').every((l) => l.length < 160), 'no crowded single block');
  }
});
