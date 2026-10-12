import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * OWNER PERMANENT FILE-WFLOW REPAIR (2026-10-12) — REGRESSION SUITE.
 * Every scenario goes through the REAL webhook pipeline; the only direct
 * DB touches are the ones a real crash/timeout would produce (stuck states,
 * rewindable timestamps).
 *
 *  T1  gateway URL EXPIRED before approval → publish still works from the
 *      receipt-time stash (ROOT CAUSE of "kabhi upload hota hai kabhi nahi")
 *  T2  receipt stash fails → question still asked → publish falls back to
 *      re-download + stash-back
 *  T3  transient publish failure → sweep retries with backoff → published,
 *      ONE ack (no resend, no re-ask)
 *  T4  PERMANENT failure (destination gone) → never retried, honest message
 *  T5  publish stuck beyond the attempt cap → TERMINAL failed + ONE final
 *      honest message (never an endless 'uploading')
 *  T6  AI structured output INVALID → offline rules still resolve correctly
 *  T7  Case C — approval + student instructions together → published, the
 *      teacher's verbatim words in the Note description
 *  T8  decline → stashed attachment destroyed from storage
 *  T9  24h expire → stashed attachment destroyed + CR told
 */
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('permanent_workflow_test');
process.env.JWT_SECRET = 'test-permanent-workflow-jwt';
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
const { createHash } = await import('node:crypto');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { Note, Section, Subject, Teacher, TeacherMaterial, User, OutboxMessage, Notification } = models;
const { runTeacherMaterialSweep } = await import('../backend/services/teacherMaterialService.js');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const sent = [];
let failNextCloudinary = false;
let failNextCloudinaryStreak = 0;
let cloudinaryUploads = 0;
let cloudinaryDestroys = 0;
let downloads404 = false; // gateway URL "expired" — every media download 404s
let geminiClassify = null;
let geminiApproval = null;

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
    return Promise.resolve(new Response(JSON.stringify({}), { status: 400 }));
  }
  if (u.includes('cdn.example')) {
    if (downloads404) return Promise.resolve(new Response('gone', { status: 404 }));
    const buf = createHash('md5').update(u).digest();
    return Promise.resolve(new Response(new Uint8Array(buf).buffer, { status: 200 }));
  }
  if (u.includes('/destroy')) {
    cloudinaryDestroys++;
    return Promise.resolve(new Response(JSON.stringify({ result: 'ok' }), { status: 200 }));
  }
  if (u.includes('api.cloudinary.com')) {
    if (failNextCloudinaryStreak > 0) { failNextCloudinaryStreak--; failNextCloudinary = false;
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'storage exploded' } }), { status: 500 })); }
    if (failNextCloudinary) { failNextCloudinary = false;
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'storage exploded' } }), { status: 500 })); }
    cloudinaryUploads++;
    const folder = options.body.get('folder');
    const publicId = options.body.get('public_id');
    return Promise.resolve(new Response(JSON.stringify({
      public_id: `${folder}/${publicId}.pdf`, secure_url: `https://res.cloudinary.com/demo/${folder}/${publicId}.pdf`,
      bytes: 1234, format: '', resource_type: 'raw' }), { status: 200 }));
  }
  if (u.includes('api.ultramsg.com/test-instance/messages/chat')) {
    const data = new URLSearchParams(options.body);
    sent.push({ to: data.get('to'), body: data.get('body') });
    return Promise.resolve(new Response(JSON.stringify({ sent: true }), { status: 200 }));
  }
  if (/api\.ultramsg\.com\/test-instance\/messages\/(document|image|audio|video)/.test(u)) {
    const data = new URLSearchParams(options.body);
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
const fileMsg = ({ filename, id, caption = '' }) => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id: id ?? `file-${Math.random()}`, from: '923001112233@c.us', fromMe: false, type: 'document',
    filename, caption, media: `https://cdn.example/${encodeURIComponent(filename)}`,
    time: Math.floor(Date.now() / 1000) } });
const incoming = (text) => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id: `incoming-${Math.random()}`, from: '923001112233@c.us', body: text, fromMe: false, type: 'chat',
    time: Math.floor(Date.now() / 1000) } });

let section4B, subject4B, crUser;
const teacherMsgs = () => sent.filter((s) => s.to === '923001112233').map((s) => s.body);

test.before(async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const academicSession = (await admin('POST', '/api/admin/sessions', { name: '2099–2100' })).json.data._id;
  const hash = await bcrypt.hash('Perm123!456', 10);
  crUser = await User.create({ name: 'Cr One', email: 'cr1@perm.test', phone: '+923009876543', role: 'cr',
    registrationStatus: 'active', emailVerified: true, password: hash });
  section4B = (await admin('POST', '/api/admin/sections', { department: dept, session: academicSession, semester: 4, name: '4B', cr: crUser._id.toString() })).json.data._id;
  subject4B = (await admin('POST', '/api/admin/subjects', { section: section4B, name: 'Data Structures', code: 'DS-101' })).json.data._id;
  await Teacher.create({ name: 'Dr Test', subject: subject4B, section: section4B, whatsapp: '923001112233', createdBy: crUser._id });
});
test.after(async () => {
  await mongoose.disconnect();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  await mongod.stop();
});
test.afterEach(async () => {
  await Promise.all([TeacherMaterial.deleteMany({}), Note.deleteMany({}), OutboxMessage.deleteMany({}), Notification.deleteMany({})]);
  // T4 deletes the subject to force a PERMANENT error — restore it so every
  // later test still has a valid authorized destination.
  if (!(await Subject.findById(subject4B))) {
    await Subject.create({ _id: subject4B, section: section4B, name: 'Data Structures', code: 'DS-101', createdBy: crUser._id });
  }
  sent.length = 0;
  geminiClassify = null; geminiApproval = null;
  failNextCloudinary = false; failNextCloudinaryStreak = 0;
  downloads404 = false; cloudinaryUploads = 0; cloudinaryDestroys = 0;
});

/** send a study-material file → expect the approval question + stashed attachment */
async function sendFileGetQuestion(filename) {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'lecture notes', summary: 'notes' };
  const r = await webhook(fileMsg({ filename }));
  geminiClassify = null;
  assert.equal(r.json.data.updated, true, `${filename} consumed`);
  const material = await TeacherMaterial.findOne({ filename }).lean();
  assert.equal(material.status, 'awaiting_approval', `${filename} asked for approval`);
  return material;
}

test('T1: gateway URL EXPIRED before approval — publish works from the receipt stash (root-cause fix)', async () => {
  const material0 = await sendFileGetQuestion('Expiry_Lecture.pdf');
  assert.ok(material0.attachment?.publicId, 'attachment stashed at receipt');
  assert.equal(cloudinaryUploads, 1, 'one stash upload at receipt');
  // the approval comes LATE — the gateway URL has died by then
  downloads404 = true;
  geminiApproval = { intent: 'approve', confidence: 'high' };
  const r2 = await webhook(incoming('haan kar do'));
  geminiApproval = null;
  assert.equal(r2.json.data.updated, true, 'approval consumed');
  const material = await TeacherMaterial.findOne({ filename: 'Expiry_Lecture.pdf' }).lean();
  assert.equal(material.status, 'published', 'published despite the dead URL');
  assert.equal(cloudinaryUploads, 1, 'NO second upload — the stash was reused');
  const note = await Note.findById(material.publishedNote).lean();
  assert.ok(note, 'real Note exists');
  assert.ok(note.attachments?.length, 'Note carries the stashed file');
  assert.equal(note.attachments[0].publicId, material.attachment.publicId, 'same asset as the stash');
  const acks = teacherMsgs().filter((b) => /upload ho gay/.test(b));
  assert.equal(acks.length, 1, 'exactly ONE published confirmation');
});

test('T2: receipt stash FAILS — question still asked, publish re-downloads and stash-backs', async () => {
  failNextCloudinary = true;
  const material0 = await sendFileGetQuestion('Stash_Fail.pdf');
  assert.ok(!material0.attachment, 'no stash (cloudinary failed)');
  assert.ok(material0.attachmentError, 'failure recorded for recovery');
  // restore storage — publish must fall back to the still-fresh gateway URL
  geminiApproval = { intent: 'approve', confidence: 'high' };
  const r2 = await webhook(incoming('haan kar do'));
  geminiApproval = null;
  assert.equal(r2.json.data.updated, true);
  const material = await TeacherMaterial.findOne({ filename: 'Stash_Fail.pdf' }).lean();
  assert.equal(material.status, 'published');
  assert.equal(cloudinaryUploads, 1, 'the fallback upload happened once');
  assert.ok(material.attachment?.publicId, 'stashed back for future replays');
  assert.ok(!material.attachmentError, 'attachment error cleared after the heal');
});

test('T3: transient publish failure → sweep retry-with-backoff recovers it, ONE ack, no re-ask', async () => {
  failNextCloudinary = true; // stash fails at receipt…
  await sendFileGetQuestion('Retry_Me.pdf');
  downloads404 = true; // …and the URL dies before the (fast) approval
  geminiApproval = { intent: 'approve', confidence: 'high' };
  await webhook(incoming('haan kar do'));
  geminiApproval = null;
  let material = await TeacherMaterial.findOne({ filename: 'Retry_Me.pdf' }).lean();
  assert.equal(material.status, 'failed', 'transient publish failure recorded');
  const failMsgs = teacherMsgs().filter((b) => /upload nahi ho saki/.test(b)).length;
  assert.ok(failMsgs >= 1 && failMsgs <= 2, 'honest failure message sent');
  // provider recovers — rewind the backoff window and let the sweep heal it
  downloads404 = false;
  await TeacherMaterial.collection.updateOne({ _id: material._id }, { $set: { updatedAt: new Date(Date.now() - 11 * 60 * 1000) } });
  const out = await runTeacherMaterialSweep();
  assert.equal(out.uploadRecovered, 1, 'sweep recovered the approved file');
  material = await TeacherMaterial.findOne({ filename: 'Retry_Me.pdf' }).lean();
  assert.equal(material.status, 'published', 'published by the sweep retry');
  const note = await Note.findById(material.publishedNote).lean();
  assert.ok(note, 'real Note after recovery');
  assert.equal(await Note.countDocuments({}), 1, 'exactly one Note — no duplicates');
  assert.equal(teacherMsgs().filter((b) => /upload ho gay/.test(b)).length, 1, 'ONE published ack');
  assert.equal(teacherMsgs().filter((b) => /upload nahi ho saki/.test(b)).length, failMsgs, 'no extra failure messages');
});

test('T4: PERMANENT failure (destination gone) — never retried by the sweep', async () => {
  const material0 = await sendFileGetQuestion('Perm_Fail.pdf');
  await Subject.deleteOne({ _id: subject4B }); // destination destroyed → permanent error
  geminiApproval = { intent: 'approve', confidence: 'high' };
  await webhook(incoming('haan kar do'));
  geminiApproval = null;
  let material = await TeacherMaterial.findOne({ filename: 'Perm_Fail.pdf' }).lean();
  assert.equal(material.status, 'failed', 'permanent failure');
  const failMsgs = teacherMsgs().filter((b) => /upload nahi ho saki/.test(b)).length;
  assert.ok(failMsgs >= 1, 'teacher was told honestly');
  // recreate + two sweeps — a permanent error must NEVER be retried
  await Section.updateOne({ _id: section4B }, {});
  await TeacherMaterial.collection.updateOne({ _id: material._id }, { $set: { updatedAt: new Date(Date.now() - 11 * 60 * 1000) } });
  await runTeacherMaterialSweep();
  await runTeacherMaterialSweep();
  material = await TeacherMaterial.findOne({ filename: 'Perm_Fail.pdf' }).lean();
  assert.equal(material.status, 'failed', 'still failed — permanent errors are terminal');
  assert.equal(material.uploadAttempts, 1, 'no retry burned an attempt');
  assert.equal(teacherMsgs().filter((b) => /upload nahi ho saki/.test(b)).length, failMsgs, 'no extra failure spam');
});

test('T5: publish stuck beyond the attempt cap → TERMINAL, ONE final honest message', async () => {
  const material0 = await sendFileGetQuestion('Stuck_Uploading.pdf');
  // simulate a publish that claimed, crashed, and exhausted its retries
  await TeacherMaterial.updateOne({ _id: material0._id }, { $set: {
    status: 'uploading', uploadAttempts: 5,
    uploadClaimedAt: new Date(Date.now() - 20 * 60 * 1000) } });
  await runTeacherMaterialSweep();
  const material = await TeacherMaterial.findOne({ filename: 'Stuck_Uploading.pdf' }).lean();
  assert.equal(material.status, 'failed', 'terminal — never an endless uploading row');
  assert.equal(teacherMsgs().filter((b) => /upload nahi ho saki/.test(b)).length, 1, 'ONE final honest message');
  // second sweep — still exactly one message (dedupe holds)
  await TeacherMaterial.collection.updateOne({ _id: material._id }, { $set: { updatedAt: new Date(Date.now() - 11 * 60 * 1000) } });
  await runTeacherMaterialSweep();
  assert.equal(teacherMsgs().filter((b) => /upload nahi ho saki/.test(b)).length, 1, 'still ONE — no spam');
});

test('T6: AI structured output INVALID → offline rules still resolve (approve + publish)', async () => {
  await sendFileGetQuestion('Ai_Garbage.pdf');
  geminiApproval = { intent: 'banana', confidence: 'high' }; // invalid enum — must be rejected
  const r2 = await webhook(incoming('ok kr do'));
  geminiApproval = null;
  assert.equal(r2.json.data.updated, true);
  const material = await TeacherMaterial.findOne({ filename: 'Ai_Garbage.pdf' }).lean();
  assert.equal(material.status, 'published', 'offline rules approved the clear upload verb');
  assert.ok(!material.aiIntent?.intent, 'invalid proposal was NOT stored as an intent');
});

test('T7: Case C — approval + student instructions together → verbatim words in the Note', async () => {
  await sendFileGetQuestion('Case_C.pdf');
  geminiApproval = { intent: 'provide_instructions', confidence: 'high',
    additional_instructions: 'students ko bata dena ke kal test hai' };
  const r2 = await webhook(incoming('haan kar do aur students ko bata dena ke kal test hai'));
  geminiApproval = null;
  assert.equal(r2.json.data.updated, true);
  const material = await TeacherMaterial.findOne({ filename: 'Case_C.pdf' }).lean();
  assert.equal(material.status, 'published');
  assert.match(material.teacherInstructions, /kal test hai/, 'the teacher\'s own words preserved');
  const note = await Note.findById(material.publishedNote).lean();
  assert.match(String(note.content), /kal test hai/, 'instructions reached the Note description');
  assert.equal(teacherMsgs().filter((b) => /upload ho gay/.test(b)).length, 1, 'ONE confirmation');
});

test('T8: decline → stashed attachment destroyed from storage', async () => {
  const material0 = await sendFileGetQuestion('Decline_Me.pdf');
  assert.ok(material0.attachment?.publicId, 'stash existed');
  geminiApproval = { intent: 'reject', confidence: 'high' };
  await webhook(incoming('nahi rehne do'));
  geminiApproval = null;
  const material = await TeacherMaterial.findOne({ filename: 'Decline_Me.pdf' }).lean();
  assert.equal(material.status, 'declined');
  assert.equal(cloudinaryDestroys, 1, 'the stashed asset was destroyed best-effort');
  assert.equal(await Note.countDocuments({}), 0, 'nothing published');
});

test('T9: 24h expiry → stashed attachment destroyed + CR informed', async () => {
  const material0 = await sendFileGetQuestion('Expire_Me.pdf');
  await TeacherMaterial.updateOne({ _id: material0._id }, { $set: { askedAt: new Date(Date.now() - 25 * 3600 * 1000) } });
  await runTeacherMaterialSweep();
  const material = await TeacherMaterial.findOne({ filename: 'Expire_Me.pdf' }).lean();
  assert.equal(material.status, 'expired', 'expired by the sweep');
  assert.equal(cloudinaryDestroys, 1, 'stashed asset destroyed');
  const crPings = sent.filter((s) => s.to === '923009876543' && /jawab teacher se nahi aya/.test(s.body));
  assert.ok(crPings.length >= 1, 'CR was told the task closed');
  assert.equal(await Note.countDocuments({}), 0, 'nothing published');
});
