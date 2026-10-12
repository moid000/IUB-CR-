import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createHash } from 'node:crypto';

/**
 * SMART FILE-APPROVAL SPEC (owner 2026-10-12): every approval reply is read
 * as an AUTHORIZATION with scope — both actions, one action, conditional,
 * ambiguous (confirm first), or a decline. Nothing executes that was not
 * authorized; every confirmation is honest about what actually happened.
 */
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('smart_file_approval_test');
process.env.JWT_SECRET = 'test-smart-file-approval-jwt';
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
const { Note, Section, Subject, Teacher, TeacherMaterial, TeacherQuestion, Timetable, User, Notification, OutboxMessage } = models;
const { runTeacherMaterialSweep } = await import('../backend/services/teacherMaterialService.js');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const sent = [];
let failGroupSends = false; // students'-group sends fail (partial-failure cases)
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
    if (body.includes('"upload"') || ((body.includes('"answer"') || body.includes('"intent"')) && body.includes('approve'))) {
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
    const buf = createHash('md5').update(u).digest();
    return Promise.resolve(new Response(new Uint8Array(buf).buffer, { status: 200 }));
  }
  if (u.includes('api.cloudinary.com')) {
    const folder = options.body.get('folder');
    const publicId = options.body.get('public_id');
    return Promise.resolve(new Response(JSON.stringify({
      public_id: `${folder}/${publicId}.pdf`, secure_url: `https://res.cloudinary.com/demo/${folder}/${publicId}.pdf`,
      bytes: 1234, format: '', resource_type: 'raw' }), { status: 200 }));
  }
  const isGroupTo = (to) => String(to ?? '').endsWith('@g.us');
  if (u.includes('api.ultramsg.com/test-instance/messages/chat')) {
    const data = new URLSearchParams(options.body);
    if (failGroupSends && isGroupTo(data.get('to'))) {
      return Promise.resolve(new Response(JSON.stringify({ sent: false, error: 'gateway hiccup' }), { status: 200 }));
    }
    sent.push({ to: data.get('to'), body: data.get('body') });
    return Promise.resolve(new Response(JSON.stringify({ sent: true }), { status: 200 }));
  }
  if (/api\.ultramsg\.com\/test-instance\/messages\/(document|image|audio|video)/.test(u)) {
    const data = new URLSearchParams(options.body);
    if (failGroupSends && isGroupTo(data.get('to'))) {
      return Promise.resolve(new Response(JSON.stringify({ sent: false, error: 'gateway hiccup' }), { status: 200 }));
    }
    sent.push({ to: data.get('to'), body: `[media ${data.get('caption') ?? ''}]` });
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
const fileMsg = ({ filename, id, caption = '' }) => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id: id ?? `file-${Math.random()}`, from: `${TEACHER}@c.us`, fromMe: false, type: 'document',
    filename, caption, media: `https://cdn.example/${encodeURIComponent(filename)}`,
    time: Math.floor(Date.now() / 1000) } });
const incoming = (text, id) => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id: id ?? `incoming-${Math.random()}`, from: `${TEACHER}@c.us`, body: text, fromMe: false, type: 'chat', time: Math.floor(Date.now() / 1000) } });
const sendFile = async (name) => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'lecture notes', summary: 'notes' };
  await webhook(fileMsg({ filename: name }));
  geminiClassify = null;
};
const teacherMsgs = (from = 0) => sent.slice(from).filter((s) => s.to === TEACHER);
const groupSends = (from = 0) => sent.slice(from).filter((s) => String(s.to ?? '').endsWith('@g.us'));
const rewind = (id) => TeacherMaterial.collection.updateOne({ _id: id },
  { $set: { updatedAt: new Date(Date.now() - 11 * 60 * 1000) } });

let subject, section, crUser;
test.before(async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const academicSession = (await admin('POST', '/api/admin/sessions', { name: '2099–2100' })).json.data._id;
  const hash = await bcrypt.hash('SmartApproval123!', 10);
  crUser = await User.create({ name: 'Cr One', email: 'cr1@smart.test', phone: '+923009876543', role: 'cr',
    registrationStatus: 'active', emailVerified: true, password: hash });
  section = (await admin('POST', '/api/admin/sections', { department: dept, session: academicSession, semester: 4, name: '4B', cr: crUser._id.toString() })).json.data._id;
  subject = (await admin('POST', '/api/admin/subjects', { section, name: 'Data Structures', code: 'DS-101' })).json.data._id;
  await Teacher.create({ name: 'Dr Test', subject, section, whatsapp: TEACHER, createdBy: crUser._id });
  await Subject.updateOne({ _id: subject }, { $set: { whatsappGroup: { id: '1203630888@g.us', name: 'DS Group' } } });
});
test.after(async () => {
  await mongoose.disconnect();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  await mongod.stop();
});
test.afterEach(async () => {
  geminiClassify = null; geminiApproval = null; geminiChatReply = null; geminiAnswer = null;
  failGroupSends = false;
  await Promise.all([OutboxMessage.deleteMany({}), TeacherMaterial.deleteMany({}), TeacherQuestion.deleteMany({}),
    Note.deleteMany({}), Notification.deleteMany({}), Timetable.deleteMany({}),
    models.WhatsAppEvent.deleteMany({})]);
  await Teacher.updateMany({}, { $set: { conversation: [], lastChatMsgId: '' } });
});

/* §1 — the question itself must authorize BOTH actions */

test('S1: file → ONE question that names BOTH actions (portal + students group)', async () => {
  const from = sent.length;
  await sendFile('Lecture_01.pdf');
  const asks = teacherMsgs(from).filter((m) => /study notes lag rahe hain/.test(m.body));
  assert.equal(asks.length, 1, 'exactly one approval question');
  assert.match(asks[0].body, /portal/i, 'portal named');
  assert.match(asks[0].body, /group/i, 'students group named');
  assert.equal(await Note.countDocuments({}), 0, 'nothing published by a question');
});

/* §2 — ambiguous acknowledgement is NEVER an authorization */

test('S2: "Hmm" → a BOTH-actions confirm question, NOTHING executes', async () => {
  await sendFile('Lecture_02.pdf');
  const from = sent.length;
  await webhook(incoming('Hmm'));
  assert.equal(await Note.countDocuments({}), 0, 'no upload from an ambiguous ack');
  assert.equal(groupSends().length, 0, 'no group share from an ambiguous ack');
  const mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.status, 'awaiting_approval', 'file still open');
  assert.ok(teacherMsgs(from).some((m) => /portal par upload/.test(m.body) && /group mein share/.test(m.body)
    && /clear jawab|dono kar doon ya nahi|confirm kar dein|permission de rahe/.test(m.body)),
    'a both-actions confirm question was asked');
});

test('S3: a SECOND "Hmm" → still nothing executes (the file waits for a clear yes)', async () => {
  await sendFile('Lecture_03.pdf');
  await webhook(incoming('Hmm'));
  await webhook(incoming('hmm acha'));
  assert.equal(await Note.countDocuments({}), 0, 'no upload');
  assert.equal(groupSends().length, 0, 'no share');
  const mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.status, 'awaiting_approval', 'still open after two ambiguous acks');
});

/* §4 — a clear yes executes BOTH authorized actions, honestly */

test('S4: "Haan, dono kar do" → portal Note + group share + ONE honest both-done confirmation', async () => {
  await sendFile('Lecture_04.pdf');
  const from = sent.length;
  await webhook(incoming('Haan, dono kar do'));
  assert.equal(await Note.countDocuments({}), 1, 'portal Note live');
  assert.ok(groupSends(from).length >= 1, 'students group got the material');
  const confirm = teacherMsgs(from).find((m) => /upload ho gaye hain/.test(m.body));
  assert.ok(confirm, 'confirmation sent');
  assert.match(confirm.body, /group mein bhi share/, 'confirmation states the group share too');
  // redelivery of the approval → nothing new
  const sentBefore = sent.length;
  await webhook(incoming('Haan, dono kar do', 's4-approve-1'));
  await webhook(incoming('Haan, dono kar do', 's4-approve-1'));
  assert.equal(await Note.countDocuments({}), 1, 'still exactly one Note');
  assert.equal(sent.length, sentBefore, 'a redelivery triggers NOTHING');
});

/* §5 — scoped authorization: portal ONLY */

test('S5 (offline): "Sirf portal par upload karna, group mein nahi" → portal Note, NO group share, honest wording', async () => {
  await sendFile('Lecture_05.pdf');
  const from = sent.length;
  await webhook(incoming('Sirf portal par upload karna, group mein nahi'));
  assert.equal(await Note.countDocuments({}), 1, 'portal Note live');
  assert.equal(groupSends(from).length, 0, 'group share correctly SKIPPED');
  const confirm = teacherMsgs(from).find((m) => /upload ho gaye hain/.test(m.body));
  assert.ok(confirm, 'confirmation sent');
  assert.match(confirm.body, /group mein share nahi kiya/i, 'honest: says the group was NOT shared');
  const mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.authPortal, true, 'portal authorized');
  assert.equal(mat.authGroup, false, 'group NOT authorized');
});

test('S6 (AI scope): intent approve_portal_only → portal Note only, no broadcast', async () => {
  await sendFile('Lecture_06.pdf');
  const from = sent.length;
  geminiApproval = { intent: 'approve_portal_only', confidence: 'high' };
  await webhook(incoming('ok kar do'));
  geminiApproval = null;
  assert.equal(await Note.countDocuments({}), 1, 'portal Note live');
  assert.equal(groupSends(from).length, 0, 'no group share');
  const confirm = teacherMsgs(from).find((m) => /upload ho gaye hain/.test(m.body));
  assert.ok(confirm, 'confirmation sent');
  assert.match(confirm.body, /group mein share nahi kiya/i, 'honest wording');
});

/* §6 — scoped authorization: group ONLY, never a hidden portal upload */

test('S7 (offline): "Group mein bhej do, portal nahi" → group share, NO portal Note, honest wording, CR informed', async () => {
  await sendFile('Lecture_07.pdf');
  const from = sent.length;
  await webhook(incoming('Group mein bhej do, portal nahi'));
  assert.equal(await Note.countDocuments({}), 0, 'NO portal Note — the teacher did not authorize one');
  assert.ok(groupSends(from).length >= 1, 'students group got the material');
  const ack = teacherMsgs(from).find((m) => /Portal par upload nahi kiya/.test(m.body));
  assert.ok(ack, 'honest: says it was NOT uploaded to the portal');
  const mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.status, 'shared', 'shared status (distinct from published)');
  assert.equal(mat.authPortal, false, 'portal NOT authorized');
  assert.equal(mat.authGroup, true, 'group authorized');
});

/* §3 — conditional approval: nothing executes until the condition is met */

test('S8: "Pehle title change kar do" → NOTHING executes, the title is asked, condition stored', async () => {
  await sendFile('Lecture_08.pdf');
  const from = sent.length;
  await webhook(incoming('Pehle title change kar do'));
  assert.equal(await Note.countDocuments({}), 0, 'no upload while the condition is open');
  assert.equal(groupSends(from).length, 0, 'no share while the condition is open');
  const mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.status, 'awaiting_approval', 'file open, waiting');
  assert.ok(mat.pendingCondition, 'the condition is persisted');
  assert.ok(teacherMsgs(from).some((m) => /kis title se upload kar doon/.test(m.body)),
    'the agent asked for the title');
});

test('S9: after the title ask, "Lecture 5 rakh do" → published with the TEACHER\'S title + group share', async () => {
  await sendFile('Lecture_09.pdf');
  await webhook(incoming('Pehle title change kar do'));
  const from = sent.length;
  await webhook(incoming('Lecture 5 rakh do'));
  assert.equal(await Note.countDocuments({}), 1, 'published once the title arrived');
  const note = (await Note.find({}).lean())[0];
  assert.match(note.title, /Lecture 5/i, 'the teacher\'s requested title is used');
  assert.ok(groupSends(from).length >= 1, 'group shared too (both actions were authorized)');
  assert.ok(teacherMsgs(from).some((m) => /upload ho gaye hain/.test(m.body)), 'final confirmation sent');
  const mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.status, 'published');
  assert.equal(mat.pendingCondition, '', 'condition cleared');
});

/* declines and questions never execute anything */

test('S10: "Nahi, abhi share nahi karna" → declined, nothing uploaded', async () => {
  await sendFile('Lecture_10.pdf');
  const from = sent.length;
  await webhook(incoming('Nahi, abhi share nahi karna'));
  assert.equal(await Note.countDocuments({}), 0, 'no upload');
  assert.equal(groupSends(from).length, 0, 'no share');
  const mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.status, 'declined', 'declined status');
});

test('S11: a QUESTION ("Kis group mein share karna hai?") never publishes — the file stays open', async () => {
  await sendFile('Lecture_11.pdf');
  const from = sent.length;
  await webhook(incoming('Kis group mein share karna hai?'));
  assert.equal(await Note.countDocuments({}), 0, 'no upload');
  assert.equal(groupSends(from).length, 0, 'no share');
  const mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.status, 'awaiting_approval', 'still open — the question was answered, the file was not erased');
});

test('S12: an unrelated question while a file is pending → the pending file is never erased', async () => {
  await sendFile('Lecture_12.pdf');
  await webhook(incoming('Kal class hai sir aap ki?'));
  const mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.status, 'awaiting_approval', 'pending file untouched');
  assert.equal(await Note.countDocuments({}), 0, 'nothing published');
});

/* mixed-style approvals still read as approvals */

test('S13: mixed-style "Theek hai beta, upload kar do" → both actions execute', async () => {
  await sendFile('Lecture_13.pdf');
  await webhook(incoming('Theek hai beta, upload kar do'));
  assert.equal(await Note.countDocuments({}), 1, 'portal Note live');
  assert.ok(groupSends().length >= 1, 'group shared');
});

/* §5 retry — portal ok + group fail: honest partial, share-only recovery */

test('S14: portal ok + group FAIL → honest partial message; sweep retries ONLY the share, ONE deduped follow-up', async () => {
  failGroupSends = true;
  await sendFile('Lecture_14.pdf');
  const from = sent.length;
  await webhook(incoming('haan kar do'));
  failGroupSends = false;
  assert.equal(await Note.countDocuments({}), 1, 'portal Note is LIVE');
  const partial = teacherMsgs(from).find((m) => /retry kar raha hoon/.test(m.body));
  assert.ok(partial, 'honest partial confirmation (share retrying)');
  let mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.broadcastStatus, 'failed', 'share marked failed');
  assert.equal(mat.status, 'published', 'published (portal) — the Note is not re-uploaded');

  const cloudinaryBefore = sent.filter((s) => String(s.to).includes('cloudinary')).length; // sanity: none
  await rewind(mat._id);
  await runTeacherMaterialSweep();
  mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.broadcastStatus, 'done', 'share recovered');
  assert.equal(mat.status, 'published', 'still published — no re-upload');
  const followUps = teacherMsgs(from).filter((m) => /ab students ke WhatsApp group mein bhi share ho gayi/.test(m.body));
  assert.equal(followUps.length, 1, 'exactly ONE share-recovered follow-up');
  assert.equal(cloudinaryBefore, 0, 'no upload side-effects');
  // a second sweep stays silent
  await rewind(mat._id);
  await runTeacherMaterialSweep();
  assert.equal(teacherMsgs(from).filter((m) => /ab students ke WhatsApp group mein bhi share ho gayi/.test(m.body)).length, 1,
    'no duplicate follow-up');
});

/* §6 retry — group-only share failed: sweep recovers it, still no portal upload */

test('S15: group-only share FAILS → sweep recovers the share, NO portal Note ever appears', async () => {
  failGroupSends = true;
  await sendFile('Lecture_15.pdf');
  const from = sent.length;
  await webhook(incoming('Group mein bhej do, portal nahi'));
  assert.equal(await Note.countDocuments({}), 0, 'no portal Note');
  let mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.broadcastStatus, 'failed', 'share attempt recorded');
  assert.equal(mat.status, 'awaiting_approval', 'still awaiting — share failed');

  failGroupSends = false;
  await rewind(mat._id);
  await runTeacherMaterialSweep();
  mat = (await TeacherMaterial.find({}).lean())[0];
  assert.equal(mat.status, 'shared', 'share recovered by the sweep');
  assert.equal(await Note.countDocuments({}), 0, 'still no portal Note — scope respected across retries');
  const ack = teacherMsgs(from).filter((m) => /Portal par upload nahi kiya/.test(m.body));
  assert.ok(ack.length >= 1, 'honest group-only ack (at least once)');
});
