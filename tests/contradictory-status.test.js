import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * OWNER CONTRADICTION SPEC 2026-10-12 (evening) — "Done Sir … upload ho gaye
 * hain" followed by "Maazrat Sir, 'attachment.jpg' tak main pohanch nahi
 * paya". Live trace: TWO DIFFERENT attachments, TWO honest tasks — but the
 * success line did not name its file, so the pair reads as a contradiction.
 * This suite locks in the real backend rules:
 *
 *  CS-1  the EXACT incident: file A retrieval-fails while file B publishes —
 *        B's success names B, A's resend ask names A, NO message ever claims
 *        A was uploaded, NO failure text ever mentions B
 *  CS-2  portal upload succeeds but the CR notification fails → the
 *        confirmation stays honest (retry line, never "CR ko bata diya")
 *  CS-3  retrieval fails before upload → NEVER reported as upload success;
 *        terminal after bounded retries with ONE deduped resend ask
 *  CS-4  a webhook delivered twice → one task, one action, one message
 *  CS-5  two attachments arrive almost simultaneously → two independent
 *        tasks; one failing never poisons the other's status or message
 *  CS-6  RETRY-AFTER-TERMINAL (live bug): a terminal retrieval row must
 *        NEVER be picked up by the publish-retry sweep — no claim, no
 *        'uploading' flap, no overwritten uploadError, no parse-URL noise
 *  CS-7  server restart while a publish is in flight → sweep resumes, ONE
 *        deduped confirmation, second sweep adds nothing
 *  CS-8  AI says "approve" (or claims success) for a file that is not
 *        retrievable → backend truth wins: no publish, no success message
 */
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('contradictory_status_test');
process.env.JWT_SECRET = 'test-contradictory-status-jwt';
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
process.env.WASENDER_API_KEY = 'test-wasender-key';

const { default: mongoose } = await import('mongoose');
const { createHash } = await import('node:crypto');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { Note, Section, Subject, Teacher, TeacherMaterial, User, OutboxMessage, Notification } = models;
const svc = await import('../backend/services/teacherMaterialService.js');
const { runTeacherMaterialSweep } = svc;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const TEACHER = '923001112233';
const CR = '923009876543';

const realFetch = globalThis.fetch;
const sent = [];
let failDecrypt = false;
let failDecryptIds = new Set(); // specific provider message ids whose decrypt always fails
let failSendsTo = null;
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
  if (u.includes('wasenderapi.com/api/decrypt-media')) {
    try { const j = JSON.parse(options.body);
      if (j?.data?.messages?.key?.id && failDecryptIds.has(j.data.messages.key.id)) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'decrypt service unavailable' }), { status: 500 }));
      } } catch { /* body not JSON */ }
    if (failDecrypt) return Promise.resolve(new Response(JSON.stringify({ error: 'decrypt service unavailable' }), { status: 500 }));
    return Promise.resolve(new Response(JSON.stringify(
      { data: { publicUrl: `https://cdn.example/decrypted-${Math.random().toString(16).slice(2, 8)}` } }), { status: 200 }));
  }
  if (u.includes('cdn.example')) {
    const buf = createHash('md5').update(u).digest();
    return Promise.resolve(new Response(new Uint8Array(buf).buffer, { status: 200 }));
  }
  if (u.includes('/destroy')) {
    return Promise.resolve(new Response(JSON.stringify({ result: 'ok' }), { status: 200 }));
  }
  if (u.includes('api.cloudinary.com')) {
    const folder = options.body.get('folder');
    const publicId = options.body.get('public_id');
    const isImage = /\/image\/upload/.test(u);
    return Promise.resolve(new Response(JSON.stringify({
      public_id: `${folder}/${publicId}`, secure_url: `https://res.cloudinary.com/demo/${folder}/${publicId}${isImage ? '.jpg' : ''}`,
      bytes: 1234, format: isImage ? 'jpg' : '', resource_type: isImage ? 'image' : 'raw' }), { status: 200 }));
  }
  if (u.includes('api.ultramsg.com/test-instance/messages')) {
    const data = new URLSearchParams(options.body);
    const to = data.get('to');
    if (failSendsTo && to === failSendsTo) return Promise.resolve(new Response(JSON.stringify({ error: 'rate limit' }), { status: 429 }));
    sent.push({ to, body: data.get('body') ?? `[media ${data.get('caption') ?? ''}]` });
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
const teacherMsgs = () => sent.filter((s) => s.to === TEACHER).map((s) => s.body);

const rawWrappedFile = ({ id, kind = 'documentMessage', fileName, mimetype, caption,
  innerUrl = 'https://mmg.whatsapp.net/v/t62.7118-24/ENCRYPTED' }) => {
  const media = kind === 'documentMessage'
    ? { documentMessage: { url: innerUrl, mimetype, fileName, caption, mediaKey: 'k' } }
    : { imageMessage: { url: innerUrl, mimetype, caption, mediaKey: 'k' } };
  return {
    event: 'messages.received',
    timestamp: Math.floor(Date.now() / 1000),
    data: { messages: {
      key: { id: id ?? `WA${Math.random().toString(16).slice(2, 14).toUpperCase()}`, fromMe: false,
        remoteJid: `${TEACHER}@c.us`, senderPn: `${TEACHER}@c.us`, cleanedSenderPn: TEACHER,
        senderLid: '477893582975161@lid', addressingMode: 'pn' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Teacher', broadcast: false, status: 2,
      messageBody: caption ?? '',
      message: { documentWithCaptionMessage: { message: media } },
      remoteJid: `${TEACHER}@c.us`,
    } },
  };
};

const rawChat = ({ id, text }) => ({
  event: 'messages.received',
  timestamp: Math.floor(Date.now() / 1000),
  data: { messages: {
    key: { id: id ?? `WA${Math.random().toString(16).slice(2, 14).toUpperCase()}`, fromMe: false,
      remoteJid: `${TEACHER}@c.us`, senderPn: `${TEACHER}@c.us`, cleanedSenderPn: TEACHER,
      senderLid: '477893582975161@lid', addressingMode: 'pn' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Teacher', broadcast: false, status: 2,
    messageBody: text, message: { conversation: text },
    remoteJid: `${TEACHER}@c.us`,
  } },
});

const classifyStudy = () => { geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'lecture notes', summary: 'notes' }; };

let subject4B, section4B, crUser;
test.before(async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const academicSession = (await admin('POST', '/api/admin/sessions', { name: '2099–2100' })).json.data._id;
  const hash = await bcrypt.hash('Perm123!456', 10);
  crUser = await User.create({ name: 'Cr One', email: 'cr1@contradict.test', phone: `+${CR}`, role: 'cr',
    registrationStatus: 'active', emailVerified: true, password: hash });
  section4B = (await admin('POST', '/api/admin/sections', { department: dept, session: academicSession, semester: 4, name: '4B', cr: crUser._id.toString() })).json.data._id;
  subject4B = (await admin('POST', '/api/admin/subjects', { section: section4B, name: 'Data Structures', code: 'DS-101' })).json.data._id;
  await Teacher.create({ name: 'Dr Test', subject: subject4B, section: section4B, whatsapp: TEACHER, createdBy: crUser._id });
});

test.after(async () => {
  await mongoose.disconnect();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  await mongod.stop();
});

test.afterEach(async () => {
  await Promise.all([TeacherMaterial.deleteMany({}), Note.deleteMany({}), OutboxMessage.deleteMany({}), Notification.deleteMany({})]);
  sent.length = 0;
  failDecrypt = false; failDecryptIds = new Set(); failSendsTo = null;
  geminiClassify = null; geminiApproval = null;
});

const rewind = (id, minutes) => TeacherMaterial.collection.updateOne({ _id: id },
  { $set: { createdAt: new Date(Date.now() - minutes * 60 * 1000),
    updatedAt: new Date(Date.now() - minutes * 60 * 1000) } });

test('CS-1: EXACT INCIDENT — file A retrieval-fails while file B publishes: each message names its own file, no cross-claim', async () => {
  failDecryptIds = new Set(['CS1_FILE_A']); // attachment.jpg can never be decrypted (the live incident)
  classifyStudy();
  const rA = await webhook(rawWrappedFile({ id: 'CS1_FILE_A', kind: 'imageMessage',
    mimetype: 'image/jpeg', caption: 'ye karo' })); // image → filename 'attachment.jpg'
  const rB = await webhook(rawWrappedFile({ id: 'CS1_FILE_B', fileName: 'Lecture_5_Algorithms.pdf',
    mimetype: 'application/pdf', caption: 'ye karo' }));
  geminiClassify = null;
  assert.ok(rA.json.data.updated && rB.json.data.updated, 'both consumed');

  const A = await TeacherMaterial.findOne({ waMsgId: 'CS1_FILE_A' }).lean();
  const B = await TeacherMaterial.findOne({ waMsgId: 'CS1_FILE_B' }).lean();
  assert.equal(A.status, 'retrieving', 'A is pending retrieval, NOT published');
  assert.equal(B.status, 'published', 'B published');

  // A's bounded retries exhaust → terminal
  for (let i = 0; i < 4; i += 1) { await rewind(A._id, 3); await runTeacherMaterialSweep(); }
  const Afinal = await TeacherMaterial.findById(A._id).lean();
  assert.equal(Afinal.status, 'failed', 'A terminal');
  assert.match(Afinal.uploadError, /media retrieval failed/);

  const msgs = teacherMsgs();
  const success = msgs.find((b) => /upload ho gay/.test(b));
  const ask = msgs.find((b) => /pohanch nahi paya/.test(b));
  // (a) B's success NAMES B and never mentions A
  assert.ok(success, 'B has its success confirmation');
  assert.ok(success.includes('"Lecture_5_Algorithms.pdf"'), 'success names ITS OWN file');
  assert.ok(!success.includes('attachment.jpg'), 'success never mentions the OTHER task');
  // (b) A's resend ask NAMES A and never claims an upload
  assert.ok(ask, 'A has its honest resend ask');
  assert.ok(ask.includes('"attachment.jpg"'), 'failure names ITS OWN file');
  assert.ok(!/upload ho gay/.test(ask), 'the failure never claims an upload');
  // (c) no message anywhere claims A was uploaded
  assert.equal(msgs.filter((b) => /upload ho gay/.test(b)).length, 1, 'exactly ONE success message (B only)');
  // (d) B's Note is intact and A never created one
  assert.equal(await Note.countDocuments({}), 1);
});

test('CS-2: portal upload succeeds but CR notification fails → honest pending line, never a fake CR-informed claim', async () => {
  classifyStudy();
  await webhook(rawWrappedFile({ id: 'CS2_FILE', fileName: 'Stacks_Notes.pdf',
    mimetype: 'application/pdf', caption: 'ye karo' }));
  geminiClassify = null;
  const mat = await TeacherMaterial.findOne({ waMsgId: 'CS2_FILE' }).lean();
  assert.equal(mat.status, 'published', 'upload verified');
  assert.ok(mat.publishedNote, 'real Note record');

  // now the CR ping fails on a SECOND file
  failSendsTo = CR; // the gateway 'to' format is bare digits
  await webhook(rawWrappedFile({ id: 'CS2_FILE2', fileName: 'Queues_Notes.pdf',
    mimetype: 'application/pdf', caption: 'ye karo' }));
  const confirm = teacherMsgs().filter((b) => /Queues_Notes\.pdf/.test(b)).find((b) => /upload ho gay/.test(b));
  assert.ok(confirm, 'confirmation still sent — the upload itself verified');
  assert.match(confirm, /retry kar raha hoon/, 'honest CR-pending line');
  assert.doesNotMatch(confirm, /CR ko bhi bata diya hai/, 'never claims the CR was informed');
  const notes = await Note.find({}).lean();
  assert.equal(notes.length, 2, 'both uploads are real regardless of CR ping');
});

test('CS-3: retrieval fails before upload → NEVER reported as upload success; ONE deduped resend ask across sweeps', async () => {
  failDecrypt = true;
  await webhook(rawWrappedFile({ id: 'CS3_FILE', fileName: 'Unreachable.pdf',
    mimetype: 'application/pdf', caption: 'ye karo' }));
  const mat = await TeacherMaterial.findOne({ waMsgId: 'CS3_FILE' }).lean();
  assert.equal(mat.status, 'retrieving', 'recoverable first, never published');
  for (let i = 0; i < 4; i += 1) { await rewind(mat._id, 3); await runTeacherMaterialSweep(); }
  // extra sweeps — dedupe must hold
  for (let i = 0; i < 3; i += 1) { await rewind(mat._id, 3); await runTeacherMaterialSweep(); }
  const after = await TeacherMaterial.findById(mat._id).lean();
  assert.equal(after.status, 'failed', 'terminal');
  const msgs = teacherMsgs();
  assert.equal(msgs.filter((b) => /pohanch nahi paya/.test(b)).length, 1, 'exactly ONE resend ask');
  assert.ok(!msgs.some((b) => /upload ho gay/.test(b)), 'retrieval failure NEVER becomes an upload success');
  assert.equal(await Note.countDocuments({}), 0, 'no Note for an unretrieved file');
});

test('CS-4: webhook delivered twice → ONE task, ONE action, ONE message set', async () => {
  classifyStudy();
  const payload = rawWrappedFile({ id: 'CS4_DUP', fileName: 'Once_Only.pdf',
    mimetype: 'application/pdf', caption: 'ye karo' });
  const r1 = await webhook(payload);
  const r2 = await webhook(payload); // provider redelivery
  geminiClassify = null;
  assert.ok(r1.json.data.updated && r2.json.data.updated);
  assert.equal(await TeacherMaterial.countDocuments({ waMsgId: 'CS4_DUP' }), 1, 'exactly one task row');
  assert.equal(await Note.countDocuments({}), 1, 'exactly one Note');
  const confirms = teacherMsgs().filter((b) => /upload ho gay/.test(b));
  assert.equal(confirms.length, 1, 'exactly one confirmation');
});

test('CS-5: two attachments almost simultaneously → independent tasks; one failing never poisons the other', async () => {
  failDecryptIds = new Set(['CS5_A']); // the FIRST (jpeg) can never be retrieved
  classifyStudy();
  await webhook(rawWrappedFile({ id: 'CS5_A', kind: 'imageMessage', mimetype: 'image/jpeg', caption: 'ye karo' }));
  await webhook(rawWrappedFile({ id: 'CS5_B', fileName: 'Good_Notes.pdf',
    mimetype: 'application/pdf', caption: 'ye karo' }));
  geminiClassify = null;
  const A = await TeacherMaterial.findOne({ waMsgId: 'CS5_A' }).lean();
  const B = await TeacherMaterial.findOne({ waMsgId: 'CS5_B' }).lean();
  assert.equal(A.status, 'retrieving');
  assert.equal(B.status, 'published', 'B is untouched by A\'s retrieval failure');
  assert.ok(B.publishedNote);
  // A goes terminal; B must stay exactly as it was
  for (let i = 0; i < 4; i += 1) { await rewind(A._id, 3); await runTeacherMaterialSweep(); }
  const A2 = await TeacherMaterial.findById(A._id).lean();
  const B2 = await TeacherMaterial.findById(B._id).lean();
  assert.equal(A2.status, 'failed');
  assert.equal(B2.status, 'published', 'older task finishing NEVER changes the newer task');
  assert.ok(B2.publishedNote.equals(B.publishedNote), 'B\'s Note reference unchanged');
  const confirms = teacherMsgs().filter((b) => /upload ho gay/.test(b));
  assert.equal(confirms.length, 1, 'still exactly one success (B only)');
  assert.ok(confirms[0].includes('"Good_Notes.pdf"'), 'scoped to B');
});

test('CS-6: RETRY-AFTER-TERMINAL (live bug) — a terminal retrieval row is NEVER re-published by the sweep', async () => {
  failDecryptIds = new Set(['CS6_FILE']);
  await webhook(rawWrappedFile({ id: 'CS6_FILE', fileName: 'Zombie.pdf',
    mimetype: 'application/pdf', caption: 'ye karo' }));
  const mat = await TeacherMaterial.findOne({ waMsgId: 'CS6_FILE' }).lean();
  for (let i = 0; i < 4; i += 1) { await rewind(mat._id, 3); await runTeacherMaterialSweep(); }
  const terminal = await TeacherMaterial.findById(mat._id).lean();
  assert.equal(terminal.status, 'failed', 'terminal');
  assert.match(terminal.uploadError, /media retrieval failed/);

  // LIVE BUG SHAPE: a legacy row whose uploadError was overwritten by the
  // old flapping retry ('download failed: Failed to parse URL from') —
  // the publish-retry sweep must STILL refuse it: nothing is retrievable.
  await TeacherMaterial.updateOne({ _id: mat._id },
    { $set: { uploadError: 'download failed: Failed to parse URL from ' } });
  await rewind(mat._id, 30);
  for (let i = 0; i < 3; i += 1) { await rewind(mat._id, 30); await runTeacherMaterialSweep(); }
  const after = await TeacherMaterial.findById(mat._id).lean();
  assert.equal(after.status, 'failed', 'no state flap to uploading');
  assert.equal(after.uploadAttempts, 0, 'the publish retry NEVER claimed the zombie row');
  assert.equal(after.uploadError, 'download failed: Failed to parse URL from ', 'uploadError not overwritten by another publish attempt');
  const auditText = JSON.stringify(after.audit);
  assert.ok(!auditText.includes('parse URL'), 'no more empty-URL publish attempts');
  // and no new teacher message — the dedupe holds, nothing contradicts
  assert.equal(teacherMsgs().filter((b) => /pohanch nahi paya/.test(b)).length, 1);
  assert.ok(!teacherMsgs().some((b) => /upload ho gay/.test(b)), 'never a success for a zombie task');
});

test('CS-7: server restart mid-publish → sweep resumes, ONE deduped confirmation, second sweep adds nothing', async () => {
  classifyStudy();
  await webhook(rawWrappedFile({ id: 'CS7_FILE', fileName: 'Crash_During.pdf',
    mimetype: 'application/pdf', caption: 'ye karo' }));
  geminiClassify = null;
  // simulate the crash AFTER the claim: row stuck 'uploading', no Note yet
  const mat = await TeacherMaterial.findOne({ waMsgId: 'CS7_FILE' }).lean();
  assert.equal(mat.status, 'published'); // the webhook finished it in this harness —
  // force the real crash shape: remove the Note and rewind to 'uploading'
  await Note.deleteOne({ _id: mat.publishedNote });
  await TeacherMaterial.updateOne({ _id: mat._id },
    { $set: { status: 'uploading', publishedNote: undefined, uploadClaimedAt: new Date(Date.now() - 15 * 60 * 1000) } });
  await TeacherMaterial.collection.updateOne({ _id: mat._id }, { $unset: { publishedNote: '' } });
  await runTeacherMaterialSweep(); // "restart" — sweep resumes the publish
  const resumed = await TeacherMaterial.findById(mat._id).lean();
  assert.equal(resumed.status, 'published', 'sweep finished the publish');
  assert.ok(resumed.publishedNote, 'real Note after resume');
  const confirmsAfterFirst = teacherMsgs().filter((b) => /upload ho gay/.test(b));
  await runTeacherMaterialSweep(); // second pass
  const confirmsAfterSecond = teacherMsgs().filter((b) => /upload ho gay/.test(b));
  assert.equal(confirmsAfterFirst.length, 1, 'exactly one confirmation after resume');
  assert.equal(confirmsAfterSecond.length, 1, 'second sweep adds NOTHING — deduped');
  assert.equal(await Note.countDocuments({}), 1, 'no duplicate Note across restarts');
});

test('CS-8: AI approval/success claim for an unretrievable file → backend truth wins, no publish, no success message', async () => {
  failDecrypt = true;
  await webhook(rawWrappedFile({ id: 'CS8_FILE', fileName: 'Ai_Lie.pdf',
    mimetype: 'application/pdf', caption: 'notes' })); // no approval in caption
  const mat = await TeacherMaterial.findOne({ waMsgId: 'CS8_FILE' }).lean();
  assert.equal(mat.status, 'retrieving', 'nothing retrievable yet');

  // the AI now "approves" — but there is NO file to publish
  geminiApproval = { intent: 'approve', subject: 'Data Structures', confidence: 'high' };
  const r = await webhook(rawChat({ id: 'CS8_REPLY', text: 'haan upload kar do' }));
  geminiApproval = null;
  assert.ok([true, false].includes(r.json.data.updated), 'reply processed without error');

  // backend truth: the row is still in the retrieval lifecycle — never flipped
  // to 'uploading'/'published' by an AI intent
  const after = await TeacherMaterial.findById(mat._id).lean();
  assert.ok(['retrieving', 'failed'].includes(after.status), 'AI approval cannot publish an unretrievable file');
  assert.ok(!after.publishedNote, 'no Note from an AI claim');
  assert.ok(!teacherMsgs().some((b) => /upload ho gay/.test(b)), 'NO success message for a file that was never retrieved');
  // direct call is also refused (belt and braces)
  const outcome = await svc.publishMaterial(after, { resume: true });
  assert.equal(outcome.ok, false, 'publishMaterial refuses');
  assert.equal(outcome.permanent, true, 'permanent — retried never');
  assert.match(outcome.error, /no retrievable file/);
});
