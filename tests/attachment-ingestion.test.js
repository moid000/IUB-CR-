import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * OWNER SPEC 2026-10-12 — CRITICAL WHATSAPP ATTACHMENT RECEIVING BUG.
 * Root cause this suite locks in: real teacher media WITH A CAPTION arrives
 * from Wasender WRAPPED in a Baileys wrapper message (live rawShape
 * evidence, msgIds 847BDC97A82A8A / 1E4D0E8B42EAF3):
 *   message: { messageContextInfo: {...},
 *              documentWithCaptionMessage: { message: { imageMessage|… } } }
 * The old normalizer only looked at TOP-LEVEL media keys → the file was
 * invisible → the bot told the teacher the file never arrived.
 *
 * Every test posts a RAW messages.received payload (the exact provider
 * shape) through the REAL webhook → normalizer → teacher-file pipeline.
 *
 *  AI-1  JPEG + caption 'ye karo' (wrapped) → auto-approval, real Note
 *  AI-2  .ipynb + caption 'ye kar do' (wrapped) → published, filename kept
 *  AI-3  plain PDF documentMessage (no wrapper) → approval question (regression)
 *  AI-4  decrypt-media DOWN at receipt → task persisted 'retrieving', honest
 *        ack (NEVER "not received"), sweep retries → retrieved → published
 *  AI-5  decrypt-media down FOREVER → bounded retries → terminal failed +
 *        ONE resend ask + CR informed
 *  AI-6  duplicate webhook delivery of the same wrapped message → ONE
 *        material, ONE ack (idempotent)
 *  AI-7  two different files close together → both own their task, both
 *        publish, no duplicate/lost action
 *  AI-8  encrypted WhatsApp URL is NEVER used as a publishable media URL
 *  AI-9  server "restart" during retrieval → sweep resumes the task (the
 *        retrieving row survives, createdAt rewound past the age gate)
 */
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('attachment_ingestion_test');
process.env.JWT_SECRET = 'test-attachment-ingestion-jwt';
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
const { runTeacherMaterialSweep } = await import('../backend/services/teacherMaterialService.js');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const sent = [];
let decryptCalls = 0;
let failDecrypt = false; // provider decrypt-media down (transient or permanent per test)
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
  // WASENDER decrypt-media — the ONLY legitimate source of a publishable URL
  if (u.includes('wasenderapi.com/api/decrypt-media')) {
    decryptCalls++;
    if (failDecrypt) return Promise.resolve(new Response(JSON.stringify({ error: 'decrypt service unavailable' }), { status: 500 }));
    return Promise.resolve(new Response(JSON.stringify(
      { data: { publicUrl: `https://cdn.example/decrypted-${decryptCalls}` } }), { status: 200 }));
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
    // the upload URL itself carries the resource type (…/image/upload vs
    // …/raw/upload) — mirror what Cloudinary really reports back
    const isImage = /\/image\/upload/.test(u);
    return Promise.resolve(new Response(JSON.stringify({
      public_id: `${folder}/${publicId}`, secure_url: `https://res.cloudinary.com/demo/${folder}/${publicId}${isImage ? '.jpg' : ''}`,
      bytes: 1234, format: isImage ? 'jpg' : '', resource_type: isImage ? 'image' : 'raw' }), { status: 200 }));
  }
  if (u.includes('api.ultramsg.com/test-instance/messages')) {
    const data = new URLSearchParams(options.body);
    sent.push({ to: data.get('to'), body: data.get('body') ?? `[media ${data.get('caption') ?? ''}]` });
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
const teacherMsgs = () => sent.filter((s) => s.to === '923001112233').map((s) => s.body);

/**
 * RAW Wasender messages.received payload — byte-for-byte the shape the
 * provider really delivers (live rawShape evidence 2026-10-12). Captioned
 * media rides INSIDE the documentWithCaptionMessage wrapper.
 */
const rawWrappedFile = ({ id, kind = 'documentMessage', fileName, mimetype, caption,
  innerUrl = 'https://mmg.whatsapp.net/v/t62.7118-24/ENCRYPTED' }) => {
  const media = kind === 'documentMessage'
    ? { documentMessage: { url: innerUrl, mimetype, fileName, caption, mediaKey: 'k', jpegThumbnail: 'H4sIAAAAA_base64' } }
    : { imageMessage: { url: innerUrl, mimetype, caption, mediaKey: 'k', jpegThumbnail: 'H4sIAAAAA_base64' } };
  return {
    event: 'messages.received',
    timestamp: Math.floor(Date.now() / 1000),
    data: { messages: {
      key: { id: id ?? `WA${Math.random().toString(16).slice(2, 14).toUpperCase()}`, fromMe: false,
        remoteJid: '923001112233@c.us', senderPn: '923001112233@c.us', cleanedSenderPn: '923001112233',
        senderLid: '477893582975161@lid', addressingMode: 'pn' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Teacher', broadcast: false, status: 2,
      messageBody: caption ?? '',
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2,
          messageSecret: { data: 'x', type: 'Buffer' }, botMetadata: {} },
        documentWithCaptionMessage: { message: media },
      },
      remoteJid: '923001112233@c.us',
    } },
  };
};

/** same payload family, media NOT wrapped (older client / no caption) */
const rawPlainFile = ({ id, fileName, mimetype, caption = '', innerUrl = 'https://mmg.whatsapp.net/v/t62.7118-24/ENCRYPTED' }) => ({
  event: 'messages.received',
  timestamp: Math.floor(Date.now() / 1000),
  data: { messages: {
    key: { id: id ?? `WA${Math.random().toString(16).slice(2, 14).toUpperCase()}`, fromMe: false,
      remoteJid: '923001112233@c.us', senderPn: '923001112233@c.us', cleanedSenderPn: '923001112233',
      senderLid: '477893582975161@lid', addressingMode: 'pn' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Teacher', broadcast: false, status: 2,
    messageBody: caption,
    message: { documentMessage: { url: innerUrl, mimetype, fileName, caption, mediaKey: 'k' } },
    remoteJid: '923001112233@c.us',
  } },
});

const classifyStudy = () => { geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'lecture notes', summary: 'notes' }; };

let subject4B, section4B, crUser;
test.before(async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const academicSession = (await admin('POST', '/api/admin/sessions', { name: '2099–2100' })).json.data._id;
  const hash = await bcrypt.hash('Perm123!456', 10);
  crUser = await User.create({ name: 'Cr One', email: 'cr1@ingest.test', phone: '+923009876543', role: 'cr',
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
  sent.length = 0;
  decryptCalls = 0;
  geminiClassify = null; geminiApproval = null;
  failDecrypt = false;
});

const rewind = (id, minutes) => TeacherMaterial.collection.updateOne({ _id: id },
  { $set: { createdAt: new Date(Date.now() - minutes * 60 * 1000),
    updatedAt: new Date(Date.now() - minutes * 60 * 1000) } });

test('AI-1: JPEG + caption "ye karo" wrapped in documentWithCaptionMessage → auto-published with a real Note', async () => {
  classifyStudy();
  const r = await webhook(rawWrappedFile({ kind: 'imageMessage', fileName: 'board_photo.jpeg',
    mimetype: 'image/jpeg', caption: 'ye karo' }));
  geminiClassify = null;
  assert.ok(r.json.data.updated, 'consumed');
  // real WhatsApp images carry NO fileName — the pipeline derives one from
  // the type, exactly like the live 'attachment.jpg' the bot handled
  const material = await TeacherMaterial.findOne({ filename: 'attachment.jpg' }).lean();
  assert.ok(material, 'material task exists');
  assert.equal(material.status, 'published', 'caption approval published');
  assert.ok(/image\/jpe?g/.test(material.mime), 'image mime preserved through the wrapper');
  assert.equal(material.caption, 'ye karo', 'caption extracted through the wrapper');
  assert.equal(material.autoApproved, true, 'caption was recognized as approval');
  assert.ok(material.publishedNote, 'real Note id stored');
  const note = await Note.findById(material.publishedNote).lean();
  assert.ok(note, 'Note actually saved in the portal');
  assert.ok(note.attachments?.length, 'Note carries the real file');
  assert.ok(teacherMsgs().some((b) => /upload ho gay/.test(b)), 'teacher confirmed');
});

test('AI-2: .ipynb + caption "ye kar do" wrapped → published, original filename preserved, never executed', async () => {
  classifyStudy();
  const r = await webhook(rawWrappedFile({ fileName: 'Lecture_3_Operators.ipynb',
    mimetype: 'application/octet-stream', caption: 'ye kar do' }));
  geminiClassify = null;
  assert.ok(r.json.data.updated);
  const material = await TeacherMaterial.findOne({ filename: 'Lecture_3_Operators.ipynb' }).lean();
  assert.ok(material, 'ipynb material exists');
  assert.equal(material.status, 'published');
  assert.equal(material.ext, 'ipynb', 'format identified by extension');
  assert.ok(material.publishedNote, 'real Note id stored');
  const note = await Note.findById(material.publishedNote).lean();
  assert.ok(note, 'real Note saved');
  assert.equal(note.attachments?.[0]?.publicId, material.attachment?.publicId, 'the SAME stashed asset — no placeholder, no unrelated link');
});

test('AI-3: plain PDF (no wrapper) still asks for approval — normal path regression', async () => {
  classifyStudy();
  const r = await webhook(rawPlainFile({ fileName: 'plain_lecture.pdf', mimetype: 'application/pdf' }));
  geminiClassify = null;
  assert.ok(r.json.data.updated);
  const material = await TeacherMaterial.findOne({ filename: 'plain_lecture.pdf' }).lean();
  assert.equal(material.status, 'awaiting_approval', 'no caption → approval question, no silent publish');
  assert.ok(teacherMsgs().some((b) => /upload kar doon|share kar doon/.test(b)), 'approval question sent');
});

test('AI-4: decrypt-media down at receipt → task persisted retrievable, honest ack, sweep retries → published', async () => {
  failDecrypt = true;
  classifyStudy();
  const r = await webhook(rawWrappedFile({ fileName: 'retry_me.pdf', mimetype: 'application/pdf', caption: 'ye karo' }));
  geminiClassify = null;
  assert.ok(r.json.data.updated, 'consumed (no silent drop)');
  const material = await TeacherMaterial.findOne({ filename: 'retry_me.pdf' }).lean();
  assert.ok(material, 'task persisted even though retrieval failed');
  assert.equal(material.status, 'retrieving', 'recoverable retrieval state');
  assert.ok(material.rawMessage?.documentMessage ?? material.rawMessage?.imageMessage,
    'raw encrypted media persisted for retry');
  assert.ok(!JSON.stringify(material.rawMessage).includes('jpegThumbnail'), 'thumbnail stripped before persisting');
  assert.ok(!material.mediaUrl.includes('mmg.whatsapp.net'), 'encrypted URL never used as publishable URL');
  const msgs = teacherMsgs();
  assert.ok(msgs.some((b) => /mil gayi hai/.test(b)), 'teacher told the file ARRIVED');
  assert.ok(!msgs.some((b) => /dobara bhej/.test(b)), 'teacher NOT asked to resend while a retry exists');

  // provider recovers → sweep retries retrieval → full flow resumes
  failDecrypt = false;
  await rewind(material._id, 3);
  const report = await runTeacherMaterialSweep();
  assert.equal(report.retrievalRecovered, 1, 'sweep recovered the attachment');
  const after = await TeacherMaterial.findOne({ filename: 'retry_me.pdf' }).lean();
  assert.equal(after.status, 'published', 'recovered file published through the normal flow');
  assert.ok(after.publishedNote, 'real Note created');
  const acks = teacherMsgs().filter((b) => /upload ho gay/.test(b));
  assert.equal(acks.length, 1, 'exactly ONE published confirmation');
});

test('AI-5: decrypt-media down FOREVER → bounded retries → terminal failed + ONE resend ask + CR informed', async () => {
  failDecrypt = true;
  await webhook(rawWrappedFile({ fileName: 'gone_forever.pdf', mimetype: 'application/pdf', caption: 'ye karo' }));
  const material = await TeacherMaterial.findOne({ filename: 'gone_forever.pdf' }).lean();
  assert.equal(material.status, 'retrieving');
  // exhaust the bounded retries (each sweep run advances one attempt)
  for (let i = 0; i < 4; i += 1) {
    await rewind(material._id, 3);
    await runTeacherMaterialSweep();
  }
  const after = await TeacherMaterial.findOne({ filename: 'gone_forever.pdf' }).lean();
  assert.equal(after.status, 'failed', 'terminal after bounded retries');
  assert.equal(after.retrievalAttempts, 4, 'exactly four attempts, never an endless loop');
  const asks = teacherMsgs().filter((b) => /dobara bhej/.test(b));
  assert.equal(asks.length, 1, 'ONE honest resend ask — deduped, not repeated');
  const crNote = await Notification.findOne({ type: 'note', title: /fetch/i }).lean();
  assert.ok(crNote, 'CR informed of the failure');
});

test('AI-6: duplicate webhook delivery of a wrapped file → ONE material, ONE ack', async () => {
  classifyStudy();
  const payload = rawWrappedFile({ id: 'DUP847BDC97A82A8A', kind: 'imageMessage',
    fileName: 'dup_photo.jpeg', mimetype: 'image/jpeg', caption: 'ye karo' });
  const r1 = await webhook(payload);
  const r2 = await webhook(payload); // Wasender redelivery — identical message id
  geminiClassify = null;
  assert.ok(r1.json.data.updated);
  assert.ok(r2.json.data.updated, 'redelivery consumed (200, not an error)');
  const materials = await TeacherMaterial.find({ waMsgId: 'DUP847BDC97A82A8A' }).lean();
  assert.equal(materials.length, 1, 'exactly ONE task row');
  const acks = teacherMsgs().filter((b) => /upload ho gay/.test(b));
  assert.equal(acks.length, 1, 'exactly ONE confirmation — no duplicate action');
  const notes = await Note.find({}).lean();
  assert.equal(notes.length, 1, 'exactly ONE Notes record');
});

test('AI-7: two different files close together → both tasks processed, no cross-binding', async () => {
  classifyStudy();
  const r1 = await webhook(rawWrappedFile({ id: 'TWO_A1', fileName: 'first_file.pdf',
    mimetype: 'application/pdf', caption: 'ye karo' }));
  const r2 = await webhook(rawWrappedFile({ id: 'TWO_B2', fileName: 'second_file.ipynb',
    mimetype: 'application/octet-stream', caption: 'ye kar do' }));
  geminiClassify = null;
  assert.ok(r1.json.data.updated);
  assert.ok(r2.json.data.updated);
  const materials = await TeacherMaterial.find({ waMsgId: { $in: ['TWO_A1', 'TWO_B2'] } }).lean();
  assert.equal(materials.length, 2, 'every attachment owns its OWN task');
  for (const m of materials) {
    assert.equal(m.status, 'published', `${m.filename} published independently`);
    assert.ok(m.publishedNote, `${m.filename} has its own Note`);
  }
  const notes = await Note.find({}).lean();
  assert.equal(notes.length, 2, 'two Notes — no duplicate, no loss');
  const acks = teacherMsgs().filter((b) => /upload ho gay/.test(b));
  assert.equal(acks.length, 2, 'one confirmation per file');
});

test('AI-8: encrypted WhatsApp URL is never published or stashed as if it were a real file', async () => {
  classifyStudy();
  await webhook(rawPlainFile({ fileName: 'enc_check.pdf', mimetype: 'application/pdf', caption: 'ye karo' }));
  geminiClassify = null;
  const material = await TeacherMaterial.findOne({ filename: 'enc_check.pdf' }).lean();
  assert.ok(material.attachment?.publicId, 'stashed via the DECRYPTED url');
  assert.notEqual(material.attachment?.publicId, undefined);
  assert.ok(!material.mediaUrl.includes('mmg.whatsapp.net'), 'mediaUrl is the provider-decrypted URL');
});

test('AI-9: restart during retrieval — the persisted retrieving row survives and the sweep finishes it', async () => {
  failDecrypt = true;
  await webhook(rawWrappedFile({ fileName: 'crash_during_retrieval.pdf', mimetype: 'application/pdf', caption: 'ye karo' }));
  const material = await TeacherMaterial.findOne({ filename: 'crash_during_retrieval.pdf' }).lean();
  assert.equal(material.status, 'retrieving');
  // simulate a server restart: the row simply persists (createdAt rewound
  // past the sweep's age gate), the provider heals, the sweep finishes the job
  failDecrypt = false;
  await rewind(material._id, 10);
  const report = await runTeacherMaterialSweep();
  assert.equal(report.retrievalRecovered, 1);
  const after = await TeacherMaterial.findOne({ filename: 'crash_during_retrieval.pdf' }).lean();
  assert.equal(after.status, 'published', 'no pending task was lost across the restart');
  assert.ok(after.publishedNote);
});
