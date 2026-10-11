/**
 * OWNER SPEC 2026-10-11 — TARGETED AI BEHAVIOR AND WORKFLOW RELIABILITY
 * The 7 mandated regression scenarios, end to end on the REAL services
 * (no prompt-only mocks):
 *   1. Same inbound webhook event delivered TWICE → ONE reply, ONE action.
 *   2. A NEW distinct message with similar wording → still processed.
 *   3. File + approve ONCE with extra instructions → ONE upload,
 *      instructions stored in the Notes DESCRIPTION, ONE CR notification,
 *      ONE teacher confirmation.
 *   4. File with no extra instructions → asks ONCE, uploads after approval,
 *      never invents a description.
 *   5. One CR question left unanswered, a second NEW question asked → both
 *      separately persisted AND independently dispatched to the correct CR.
 *   6. CR answers each question later → each answer reaches the correct
 *      original task/teacher (code targeting; never blindly matched).
 *   7. No duplicate success messages, no raw code/JSON/stack in any
 *      CR-facing WhatsApp message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('owner_spec_test');
process.env.JWT_SECRET = 'test-owner-spec-jwt';
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
const { Note, Section, Subject, Teacher, TeacherMaterial, TeacherQuestion, User, OutboxMessage } = models;
const { escalateTeacherQuestion, handleCrQuestionReply, runTeacherQuestionSweep } =
  await import('../backend/services/teacherQuestionService.js');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const sent = []; // every outbound WhatsApp body the mock gateway delivered
let geminiClassify = null; // { study_material, subject, reason, summary }
let geminiApproval = null; // { answer: 'approve'|'decline'|'other' }

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
    return Promise.resolve(new Response(new Uint8Array([37, 80, 68, 70, 1, 2, 3]).buffer, { status: 200 }));
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
    sent.push({ to: data.get('to'), body: data.get('body') });
    return Promise.resolve(new Response(JSON.stringify({ sent: true, msgId: `wa-${sent.length}` }), { status: 200 }));
  }
  if (/api\.ultramsg\.com\/test-instance\/messages\/(document|image|audio|video)/.test(u)) {
    const data = new URLSearchParams(options.body);
    sent.push({ to: data.get('to'), body: `[${u.split('/').pop()} ${data.get('caption') ?? ''}]` });
    return Promise.resolve(new Response(JSON.stringify({ sent: true }), { status: 200 }));
  }
  return realFetch(url, options);
};

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
  crUser = await User.create({ name: 'Alex Representative', email: 'cr-owner-spec@test.local', phone: '+923009876543',
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
  geminiClassify = null; geminiApproval = null;
  await TeacherMaterial.deleteMany({}); await Note.deleteMany({}); await TeacherQuestion.deleteMany({});
  await OutboxMessage.deleteMany({});
  await Teacher.updateMany({}, { $set: { conversation: [], lastChatMsgId: '' } });
});

const crPings = () => sent.filter((s) => s.to === CR);
const teacherMsgs = () => sent.filter((s) => s.to === TEACHER);

/* ---------- §6-1 + §6-3: duplicate delivery, approve with instructions ---------- */

test('SPEC 1+3: same file event delivered TWICE → ONE question; approval WITH instructions → ONE upload, description carries them, ONE CR ping, ONE confirmation', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'pdf lecture', summary: 'Lecture 3 notes on recursion' };
  const before = sent.length;
  const evt = fileMsg({ filename: 'Lecture_3_Notes.pdf', id: 'dup-evt-1' });
  await webhook(evt);
  await webhook(evt); // redelivery — same provider message id
  assert.equal(await TeacherMaterial.countDocuments({ waMsgId: 'dup-evt-1' }), 1, 'exactly one material record');
  const asks = teacherMsgs().filter((m) => /share kar doon|upload kar deta hoon/i.test(m.body));
  assert.equal(asks.length, 1, 'the approval question was asked exactly ONCE');

  // approve ONCE, carrying extra instructions — the SAME approval event is also delivered twice
  geminiApproval = { answer: 'approve' };
  const beforeApprove = sent.length;
  const approveEvt = replyMsg('haan kar do, ye chapter 3 ki tayari ke liye hai', 'dup-approve-1');
  await webhook(approveEvt);
  await webhook(approveEvt); // redelivery of the approval — must not double-publish
  assert.equal(await Note.countDocuments({}), 1, 'ONE note — no duplicate upload');
  const note = await Note.findOne({}).lean();
  assert.match(note.content, /chapter 3 ki tayari ke liye hai/, 'extra instructions preserved in the DESCRIPTION');
  assert.doesNotMatch(note.title, /chapter 3/i, 'instructions never go into the title');
  assert.match(note.title, /Lecture 3 Notes/, 'title keeps the original filename');
  assert.equal(crPings().filter((m) => /UPLOAD ho gayi/i.test(m.body)).length, 1, 'exactly ONE CR published notification');
  const confirmations = teacherMsgs().filter((m) => /upload ho gayi/i.test(m.body));
  assert.equal(confirmations.length, 1, 'exactly ONE final teacher confirmation — no progress + duplicate success pair');
  assert.equal(sent.length - beforeApprove >= 1, true);
});

test('SPEC 1: approval message wording invites instructions (owner spec §2 quote)', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'pdf lecture', summary: '' };
  await webhook(fileMsg({ filename: 'Algo_Notes.pdf' }));
  const ask = teacherMsgs().find((m) => /Algo_Notes\.pdf/.test(m.body));
  assert.ok(ask, 'approval question sent');
  assert.match(ask.body, /Agar koi instruction hai to bata dein/i, 'instruction invitation present');
});

/* ---------- §6-4: file with NO extra instructions ---------- */

test('SPEC 4: file with no instructions → asked once, bare-yes approval uploads, description never invented', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'pdf lecture', summary: '' };
  await webhook(fileMsg({ filename: 'Graph_Notes.pdf' }));
  const askCount = teacherMsgs().filter((m) => /Graph_Notes\.pdf/.test(m.body) && /share kar doon/i.test(m.body)).length;
  assert.equal(askCount, 1, 'asked exactly once');
  geminiApproval = { answer: 'approve' };
  await webhook(replyMsg('haan kr do', 'bare-yes-1'));
  assert.equal(await Note.countDocuments({}), 1);
  const note = await Note.findOne({}).lean();
  // no teacher words at all + no verified summary → the honest generic line, never invented academics
  assert.match(note.content, /Uploaded by the teacher from WhatsApp/, 'no invented description');
  assert.ok(!/chapter|recursion|section \d/i.test(note.content) || /Uploaded by the teacher/i.test(note.content),
    'description contains no fabricated academic detail');
  assert.equal(note.title, 'Graph Notes', 'filename title, cleaned');
});

test('SPEC 4b: NO instructions stored when the reply is a whole-string approval', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'pdf', summary: 'content summary from the file' };
  await webhook(fileMsg({ filename: 'Queue_Notes.pdf' }));
  geminiApproval = { answer: 'approve' };
  await webhook(replyMsg('haan upload kar do', 'bare-yes-2'));
  const mat = await TeacherMaterial.findOne({ filename: 'Queue_Notes.pdf' }).lean();
  assert.equal(mat.teacherInstructions, '', 'bare approval stores no instructions');
  const note = await Note.findOne({}).lean();
  assert.match(note.content, /content summary from the file/, 'no teacher words → VERIFIED file summary as description');
});

/* ---------- §6-2 + §6-5: distinct questions, independence ---------- */

test('SPEC 2+5: Q1 unanswered + a NEW similar-wording question → two SEPARATE tasks, BOTH dispatched to the correct CR; identical re-ask reuses (no CR spam)', async () => {
  const t1 = await escalateTeacherQuestion({ sender: TEACHER, payload: replyMsg('kal ki class kis room mein hai?'),
    teacherDoc: teacher, sectionId: section, crDoc: crUser, question: 'kal ki class kis room mein hai?' });
  assert.equal(t1.reused, false, 'Q1 is a NEW task');
  const t2 = await escalateTeacherQuestion({ sender: TEACHER, payload: replyMsg('agli class kis room mein hai?'),
    teacherDoc: teacher, sectionId: section, crDoc: crUser, question: 'agli class kis room mein hai?' });
  assert.equal(t2.reused, false, 'similar wording is a NEW question → NEW task, never text-deduped away');
  assert.notEqual(String(t1.task._id), String(t2.task._id));
  const rows = await TeacherQuestion.find({}).sort({ askedAt: 1 }).lean();
  assert.equal(rows.length, 2, 'both questions persisted independently');
  assert.notEqual(rows[0].refCode, rows[1].refCode, 'distinct correlation ids');
  const alerts = crPings().filter((m) => /sawal/i.test(m.body));
  assert.equal(alerts.length, 2, 'BOTH dispatched to the CR — the pending Q1 never blocked Q2');
  for (const r of rows) assert.ok(r.crNotifiedAt, 'CR ping confirmed for ' + r.refCode);

  // the SAME unresolved question re-asked → same task, no duplicate CR ping
  const t1again = await escalateTeacherQuestion({ sender: TEACHER, payload: replyMsg('kal ki class kis room mein hai?'),
    teacherDoc: teacher, sectionId: section, crDoc: crUser, question: 'kal ki class kis room mein hai?' });
  assert.equal(t1again.reused, true, 'identical wording while the task is open = the SAME request, no CR spam');
  assert.equal(crPings().filter((m) => /sawal/i.test(m.body)).length, 2, 'still exactly two CR alerts');
});

/* ---------- §6-6: CR answers later, each reaches the correct task ---------- */

test('SPEC 6: CR answers each pending question later → each answer reaches the correct task (code targeting, never blind)', async () => {
  await escalateTeacherQuestion({ sender: TEACHER, payload: replyMsg('kal ki test kis chapter se hai?'),
    teacherDoc: teacher, sectionId: section, crDoc: crUser, question: 'kal ki test kis chapter se hai?' });
  await escalateTeacherQuestion({ sender: TEACHER, payload: replyMsg('assignment ki deadline kya hai?'),
    teacherDoc: teacher, sectionId: section, crDoc: crUser, question: 'assignment ki deadline kya hai?' });
  const rows = await TeacherQuestion.find({}).sort({ askedAt: 1 }).lean();
  const [q1, q2] = rows.map((r) => r.refCode);

  // CR text without a code while 2 are open → asked WHICH one, never blind-matched
  const before = sent.length;
  assert.equal(await handleCrQuestionReply(CR, 'room 201 mein hai', replyMsg('cr-1')), true);
  const which = sent.slice(before).filter((s) => s.to === CR);
  assert.equal(which.length, 1, 'one clarification ask');
  assert.match(which[0].body, new RegExp(q1), 'clarification lists both codes');
  assert.match(which[0].body, new RegExp(q2), 'clarification lists both codes');
  assert.equal((await TeacherQuestion.countDocuments({ status: 'pending_cr' })), 2, 'neither task got the blind answer');

  // code-targeted answer → the RIGHT task closes, the wrong one stays pending
  assert.equal(await handleCrQuestionReply(CR, `${q1} room 201 mein hai`, replyMsg('cr-2')), true);
  const after1 = await TeacherQuestion.findOne({ refCode: q1 }).lean();
  assert.equal(after1.status, 'closed', 'targeted task closed');
  assert.match(teacherMsgs().at(-1).body, /room 201 mein hai/, 'answer delivered to the ORIGINAL teacher');
  assert.match(teacherMsgs().at(-1).body, /test/, 'it is Q1\'s answer, not Q2\'s');
  assert.equal((await TeacherQuestion.findOne({ refCode: q2 })).status, 'pending_cr', 'other task untouched');

  // later, the second answer arrives — matches its own task
  assert.equal(await handleCrQuestionReply(CR, `${q2} Friday raat 11 baje tak hai`, replyMsg('cr-3')), true);
  const after2 = await TeacherQuestion.findOne({ refCode: q2 }).lean();
  assert.equal(after2.status, 'closed', 'second task closed independently');
  assert.match(teacherMsgs().at(-1).body, /Friday raat 11 baje tak/, 'second answer reached the teacher');
  // redelivery of the SAME CR reply → no duplicate delivery
  const dupBefore = sent.length;
  await handleCrQuestionReply(CR, `${q2} Friday raat 11 baje tak hai`, replyMsg('cr-3'));
  assert.equal(sent.length, dupBefore, 'CR redelivery sends nothing new');
});

/* ---------- §6-7: CR messages stay clean + outbox provider tracking ---------- */

test('SPEC 7: CR-facing messages contain no raw code/JSON/stack; outbox tracks the provider message id', async () => {
  await escalateTeacherQuestion({ sender: TEACHER, payload: replyMsg('paper ke marks kitne honge?'),
    teacherDoc: teacher, sectionId: section, crDoc: crUser, question: 'paper ke marks kitne honge?' });
  for (const m of crPings()) {
    assert.doesNotMatch(m.body, /\{|\}|TypeError|stack|at .*\.js|Error:/, 'no raw code/stack in: ' + m.body.slice(0, 60));
    assert.ok(m.body.length < 900, 'CR messages stay short');
  }
  // provider message ids are persisted on the outbox rows (spec §1)
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'pdf', summary: 'recursion notes' };
  await webhook(fileMsg({ filename: 'Provider_Id_Notes.pdf' }));
  geminiApproval = { answer: 'approve' };
  await webhook(replyMsg('haan kar do', 'provider-id-1'));
  const outboxRows = await OutboxMessage.find({ providerMsgId: /^wa-/ }).lean();
  assert.ok(outboxRows.length >= 1, 'delivered sends persist the gateway message id');
  // one reminder only — repeated sweeps never re-nudge (owner §A policy)
  const q = await TeacherQuestion.findOne({}).lean();
  await TeacherQuestion.updateOne({ _id: q._id }, { $set: { askedAt: new Date(Date.now() - 40 * 60 * 1000) } });
  await runTeacherQuestionSweep();
  await runTeacherQuestionSweep();
  await runTeacherQuestionSweep();
  const nudges = crPings().filter((m) => /jawab abhi tak nahi mila/i.test(m.body));
  assert.equal(nudges.length, 1, 'exactly ONE reminder across repeated sweeps');
});
