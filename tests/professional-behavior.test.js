import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/* Tri3M PROFESSIONAL BEHAVIOR SPEC (owner 2026-10-11) — the seven required
 * scenarios, run against the REAL webhook + services on an in-memory Mongo:
 *   T1  approved upload + CR notification both succeed → exactly ONE final
 *       confirmation that states both VERIFIED outcomes.
 *   T2  upload succeeds, CR notification fails → honest partial message; the
 *       sweep retries the CR notification WITHOUT re-uploading.
 *   T3  duplicate webhook delivery of the approval → no duplicate
 *       confirmation, no duplicate Note, no duplicate CR notification.
 *   T4  a separate NEW file after all that → still processed normally.
 *   T5  unknown question → exactly ONE ack; CR reply → answer delivered to
 *       the teacher once, redelivered CR reply changes nothing.
 *   T6  concise natural style: no signature footers, 1-2 sentence final
 *       confirmations, Roman Urdu default + English mirroring.
 *   T7  duplicate webhook delivery of the FILE itself → one material, one
 *       approval question.
 */

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('professional_behavior_test');
process.env.JWT_SECRET = 'test-professional-behavior-jwt';
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
const { Note, Section, Subject, Teacher, TeacherMaterial, TeacherQuestion, Timetable, User, OutboxMessage } = models;
const { runTeacherMaterialSweep } = await import('../backend/services/teacherMaterialService.js');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const sent = []; // every gateway send: { to, body }
let failSendsTo = null; // a destination whose sends always FAIL (T2)
let geminiClassify = null;
let geminiApproval = null;
let geminiChatReply = null;
let geminiAnswer = null;

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
    if (body.includes('"reply"')) {
      return Promise.resolve(geminiChatReply
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiChatReply) }] } }] }), { status: 200 })
        : new Response(JSON.stringify({}), { status: 400 }));
    }
    return Promise.resolve(geminiAnswer
      ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: geminiAnswer }) }] } }] }), { status: 200 })
      : new Response(JSON.stringify({}), { status: 400 }));
  }
  if (u.includes('cdn.example')) {
    // PER-FILE unique content: the production sha256 duplicate-dedupe is
    // content-based, so every test file must have its own bytes.
    const name = decodeURIComponent(u.split('/').pop() ?? 'f');
    return Promise.resolve(new Response(new TextEncoder().encode(`PDF-CONTENT-${name}`).buffer, { status: 200 }));
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
    sent.push({ to, body: data.get('body') });
    if (to === failSendsTo) return Promise.resolve(new Response(JSON.stringify({ sent: false, error: 'gateway rejected' }), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ sent: true }), { status: 200 }));
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
const TEACHER = '923001112233';
const CR_PHONE = '923009876543';
const incoming = (text, from = `${TEACHER}@c.us`, id = `incoming-${Math.random()}`) => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id, from, body: text, fromMe: false, type: 'chat', time: Math.floor(Date.now() / 1000) } });
const fileMsg = ({ filename, mime = 'application/pdf', type = 'document', caption = '', id } = {}) => ({
  event_type: 'message_received', instanceId: 'test-instance',
  data: { id: id ?? `file-${Math.random()}`, from: `${TEACHER}@c.us`, fromMe: false, type,
    filename, mimetype: mime, caption, media: `https://cdn.example/${encodeURIComponent(filename)}`,
    time: Math.floor(Date.now() / 1000) } });

let section, subject, crId;
test.before(async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const academicSession = (await admin('POST', '/api/admin/sessions', { name: '2099–2100' })).json.data._id;
  section = (await admin('POST', '/api/admin/sections', { department: dept, session: academicSession, semester: 4, name: '4B' })).json.data._id;
  subject = (await admin('POST', '/api/admin/subjects', { section, name: 'Data Structures', code: 'DS-101' })).json.data._id;
  const hash = await bcrypt.hash('TeacherTest123!', 10);
  const crDoc = await User.create({ name: 'Alex Representative', email: 'cr-prof@test.local', phone: '+923009876543', role: 'cr', section,
    registrationStatus: 'active', emailVerified: true, password: hash });
  crId = crDoc._id;
  await Section.updateOne({ _id: section }, { $set: { cr: crDoc._id } });
  await Teacher.create({ name: 'Dr Test', subject, section, whatsapp: TEACHER, createdBy: crId });
});

/* T7 — duplicate webhook delivery of the FILE itself */
test('T7: the same FILE delivered twice by the webhook → ONE material row, ONE approval question', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  const dupId = `file-dup-${Math.random()}`;
  await webhook(fileMsg({ filename: 'T7_Lecture.pdf', id: dupId }));
  const asksAfterFirst = sent.filter((s) => s.to === TEACHER && /share kar doon|upload kar deta hoon/i.test(s.body));
  await webhook(fileMsg({ filename: 'T7_Lecture.pdf', id: dupId })); // Wasender redelivery — same msgId
  const asksAfterSecond = sent.filter((s) => s.to === TEACHER && /share kar doon|upload kar deta hoon/i.test(s.body));
  assert.equal(asksAfterFirst.length, 1, 'approval question asked once');
  assert.equal(asksAfterSecond.length, 1, 'redelivery did NOT ask again');
  assert.equal(await TeacherMaterial.countDocuments({ waMsgId: dupId }), 1, 'exactly one material row');
  // cleanup: decline it so no awaiting material leaks into the next test
  geminiApproval = { answer: 'decline' };
  await webhook(incoming('nahi rehne dein', `${TEACHER}@c.us`, `decline-t7-${Math.random()}`));
  geminiApproval = null;
});

/* T1 + T3 — approved upload, both actions succeed, plus a webhook redelivery
 * of the YES: exactly ONE final confirmation naming BOTH verified outcomes. */
test('T1+T3: approve → upload + CR notification verified → ONE combined confirmation; YES-redelivery changes nothing', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  await webhook(fileMsg({ filename: 'T1_Notes.pdf' }));
  const yesId = `yes-t1-${Math.random()}`;
  geminiApproval = { answer: 'approve', subject: '', section: '' };
  await webhook(incoming('haan upload kar do', `${TEACHER}@c.us`, yesId));
  const confirmations = sent.filter((s) => s.to === TEACHER && /upload ho gaye hain|upload ho gayi/.test(s.body));
  assert.equal(confirmations.length, 1, 'exactly ONE final confirmation for THIS file');
  assert.match(confirmations[0].body, /CR ko bhi bata diya hai/, 'CR outcome stated in the SAME message');
  assert.equal(await Note.countDocuments({}), 1, 'one Note');
  // Wasender redelivers the YES (same msgId) — nothing may happen again
  await webhook(incoming('haan upload kar do', `${TEACHER}@c.us`, yesId));
  assert.equal(sent.filter((s) => s.to === TEACHER && /upload ho gay/.test(s.body)).length, 1, 'redelivery: still ONE confirmation');
  assert.equal(await Note.countDocuments({}), 1, 'redelivery: still one Note');
  const mat = await TeacherMaterial.findOne({ filename: 'T1_Notes.pdf' });
  assert.equal(await OutboxMessage.countDocuments({ refKey: `material:${mat._id}:published-ack`, status: 'sent' }), 1, 'one published-ack outbox row');
  assert.equal(mat.crNotify.status, 'delivered', 'CR notification delivered');
  assert.equal(mat.uploadAttempts, 1, 'published exactly once');
  geminiApproval = null; geminiClassify = null;
});

/* T2 — upload succeeds, CR notification FAILS: honest partial confirmation +
 * sweep retries the CR ping WITHOUT re-uploading. */
test('T2: CR notification fails → honest partial message; sweep retries the ping, never re-uploads', async () => {
  const fromT2 = sent.length;
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  await webhook(fileMsg({ filename: 'T2_Notes.pdf' }));
  failSendsTo = CR_PHONE; // the CR ping fails at the gateway
  geminiApproval = { answer: 'approve', subject: '', section: '' };
  await webhook(incoming('yes', `${TEACHER}@c.us`, `yes-t2-${Math.random()}`));
  failSendsTo = null;
  const confirm = sent.slice(fromT2).filter((s) => s.to === TEACHER && /upload ho gaye hain|upload ho gayi/.test(s.body));
  assert.equal(confirm.length, 1, 'one final confirmation');
  assert.match(confirm[0].body, /retry kar raha hoon/i, 'honest CR-pending line — no fake CR-informed claim');
  assert.doesNotMatch(confirm[0].body, /CR ko bhi bata diya hai/, 'never claims the CR was informed');
  const notesBefore = await Note.countDocuments({});
  assert.equal(notesBefore, 2, 'upload itself succeeded');
  const mat = await TeacherMaterial.findOne({ filename: 'T2_Notes.pdf' });
  assert.equal(mat.crNotify.status, 'pending', 'crNotify pending — a REAL retry job owns it');
  const attemptsBefore = mat.uploadAttempts;
  // pretend 6 minutes passed → the sweep's crNotify retry is due
  await TeacherMaterial.updateOne({ _id: mat._id },
    { $set: { 'crNotify.lastTriedAt': new Date(Date.now() - 6 * 60 * 1000) } });
  const out = await runTeacherMaterialSweep();
  assert.equal(out.crNotifyRetried, 1, 'sweep retried the CR notification');
  assert.equal(out.crNotifyDelivered, 1, 'retry delivered it');
  assert.ok(sent.some((s) => s.to === CR_PHONE && /portal par upload kiye hain/i.test(s.body)), 'CR actually received the ping');
  const after = await TeacherMaterial.findOne({ filename: 'T2_Notes.pdf' });
  assert.equal(after.crNotify.status, 'delivered', 'CR notification delivered by retry');
  assert.equal(await Note.countDocuments({}), notesBefore, 'no re-upload happened');
  assert.equal(after.uploadAttempts, attemptsBefore, 'publish not repeated');
  geminiApproval = null; geminiClassify = null;
});

/* T4 — after all the dedupe work, a genuinely NEW file is still processed. */
test('T4: a separate NEW file after the duplicates → processed normally', async () => {
  const fromT4 = sent.length;
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  await webhook(fileMsg({ filename: 'T4_Fresh_Notes.pdf' }));
  assert.equal(await TeacherMaterial.countDocuments({ filename: 'T4_Fresh_Notes.pdf' }), 1, 'new material row');
  const asks = sent.slice(fromT4).filter((s) => s.to === TEACHER && /study notes lag rahe hain/i.test(s.body));
  assert.equal(asks.length, 1, 'its own approval question asked once');
  geminiApproval = { answer: 'approve', subject: '', section: '' };
  await webhook(incoming('YES', `${TEACHER}@c.us`, `yes-t4-${Math.random()}`));
  const confirms = sent.slice(fromT4).filter((s) => s.to === TEACHER && /upload ho gaye hain|upload ho gayi/.test(s.body));
  assert.equal(confirms.length, 1, 'its own single final confirmation');
  assert.equal(await Note.countDocuments({}), 3, 'third Note published');
  geminiApproval = null; geminiClassify = null;
});

/* T5 — unknown question: ONE ack, then the CR's answer is delivered once. */
test('T5: unknown question → exactly ONE ack; CR reply → answer delivered to the teacher ONCE', async () => {
  const fromT5 = sent.length;
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main CR se confirm kar ke bata dun ga.', escalate: true };
  const qId = `q-t5-${Math.random()}`;
  const r = await webhook(incoming('Kal room change hai?', `${TEACHER}@c.us`, qId));
  assert.equal(r.json.data.updated, true, 'question consumed');
  assert.equal(await TeacherQuestion.countDocuments({ status: 'pending_cr' }), 1, 'task persisted');
  const acks = sent.slice(fromT5).filter((s) => s.to === TEACHER && /bhej di hai/.test(s.body));
  assert.equal(acks.length, 1, 'exactly ONE acknowledgement');
  assert.doesNotMatch(acks[0].body, /correct information/i, 'banned meta-phrase never used');
  // webhook redelivery of the same question → no second ack
  await webhook(incoming('Kal room change hai?', `${TEACHER}@c.us`, qId));
  assert.equal(sent.slice(fromT5).filter((s) => s.to === TEACHER && /bhej di hai/.test(s.body)).length, 1, 'redelivery: still ONE ack');
  // the CR answers → the teacher gets the answer, once
  const crReplyId = `cr-t5-${Math.random()}`;
  await webhook(incoming('Ji kal ki class Library Room 2 mein hai, 9 AM.', `${CR_PHONE}@c.us`, crReplyId));
  const answers = sent.slice(fromT5).filter((s) => s.to === TEACHER && /Library Room 2/.test(s.body));
  assert.equal(answers.length, 1, 'answer delivered to the teacher once');
  // redelivered CR reply → no duplicate delivery
  await webhook(incoming('Ji kal ki class Library Room 2 mein hai, 9 AM.', `${CR_PHONE}@c.us`, crReplyId));
  assert.equal(sent.slice(fromT5).filter((s) => s.to === TEACHER && /Library Room 2/.test(s.body)).length, 1, 'redelivery: still one answer');
  const task = await TeacherQuestion.findOne({});
  assert.equal(task.status, 'closed', 'task closed after delivery');
  geminiAnswer = null; geminiChatReply = null;
});

/* T6 — concise natural style + language mirroring. */
test('T6: concise style — no signatures, no essays, English mirror for an English-profiled teacher', async () => {
  const fromT6 = sent.length;
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  await Teacher.updateOne({ whatsapp: TEACHER }, { $set: { 'chatProfile.detectedLanguage': 'english' } });
  await webhook(fileMsg({ filename: 'T6_English_Notes.pdf' }));
  const ask = sent.slice(fromT6).filter((s) => s.to === TEACHER && /study material for Section 4B/i.test(s.body)).pop();
  assert.match(ask.body, /Share it with the students/i, 'English teacher → English question');
  assert.doesNotMatch(ask.body, /Tri3M Class Agent/i, 'no signature footer');
  geminiApproval = { answer: 'approve', subject: '', section: '' };
  await webhook(incoming('yes', `${TEACHER}@c.us`, `yes-t6-${Math.random()}`));
  const confirm = sent.slice(fromT6).filter((s) => s.to === TEACHER && /notes are uploaded|upload ho gay/i.test(s.body)).pop();
  assert.match(confirm.body, /has been informed|will be retried/i, 'CR outcome in the same message');
  assert.doesNotMatch(confirm.body, /— Tri3M Class Agent/, 'no signature footer on the confirmation');
  assert.ok(confirm.body.split('\n').length <= 3, '1-2 sentence confirmation, not an essay');
  // Roman Urdu teacher gets natural Roman Urdu (the default builders)
  await Teacher.updateOne({ whatsapp: TEACHER }, { $set: { 'chatProfile.detectedLanguage': '' } });
  await webhook(fileMsg({ filename: 'T6_Urdu_Notes.pdf' }));
  const askUr = sent.slice(fromT6).filter((s) => s.to === TEACHER && /study notes lag rahe hain/i.test(s.body)).pop();
  assert.match(askUr.body, /share kar doon/i, 'Roman Urdu question');
  geminiApproval = null; geminiClassify = null;
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  server.close();
});
