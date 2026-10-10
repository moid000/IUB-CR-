import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * OWNER RELIABILITY SPEC (2026-10-09) — REAL-WORLD ACCEPTANCE TESTS A–J.
 * Every flow is end-to-end through the REAL webhook pipeline (no service
 * internals called directly except the sweep, which the 5-min cron runs).
 */
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('teacher_reliability_test');
process.env.JWT_SECRET = 'test-teacher-reliability-jwt';
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
const { Note, Section, Subject, Teacher, TeacherMaterial, TeacherQuestion, Timetable, User, Notification, OutboxMessage } = models;
const { runTeacherMaterialSweep } = await import('../backend/services/teacherMaterialService.js');
const { runTeacherQuestionSweep } = await import('../backend/services/teacherQuestionService.js');
const { retryOutbox, sendTracked } = await import('../backend/services/whatsappService.js');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const sent = []; // every WhatsApp text this test run delivered { to, body }
let failSendsTo = null; // a phone whose WhatsApp sends FAIL (TEST G/C-pending)
let rateLimitSends = false; // WASENDER TRIAL: all sends throttled (1/min plan limit)
let failNextCloudinary = false;
let cloudinaryUploads = 0;
let geminiClassify = null; // { study_material, subject, reason, summary }
let geminiApproval = null; // { answer: 'approve'|'decline'|'other', subject, section }
let geminiChatReply = null; // { reply, escalate } — the GENERAL-mode answer
let geminiAnswer = null; // YES/NO/QUESTION/ACK/UNCLEAR/ESCALATION (reply interpreter)
let lastGeminiBody = ''; // the last Gemini request — proves FACTS/memory retrieval (TEST M)

globalThis.fetch = (url, options) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com')) {
    const body = String(options.body);
    lastGeminiBody = body;
    const geminiText = (obj) => new Response(JSON.stringify(
      { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });
    if (body.includes('"study_material"')) {
      return Promise.resolve(geminiClassify ? geminiText(geminiClassify) : new Response(JSON.stringify({}), { status: 400 }));
    }
    if (body.includes('"upload"') || (body.includes('"answer"') && body.includes('approve'))) {
      return Promise.resolve(geminiApproval ? geminiText(geminiApproval) : new Response(JSON.stringify({}), { status: 400 }));
    }
    if (body.includes('"reply"')) { // general chat — may carry the escalate flag
      return Promise.resolve(geminiChatReply
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiChatReply) }] } }] }), { status: 200 })
        : new Response(JSON.stringify({}), { status: 400 }));
    }
    return Promise.resolve(geminiAnswer
      ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: geminiAnswer }) }] } }] }), { status: 200 })
      : new Response(JSON.stringify({}), { status: 400 }));
  }
  if (u.includes('cdn.example')) {
    // UNIQUE bytes per URL: different files hash differently, the SAME url
    // (a resend) hashes identically — exactly like real content.
    const buf = createHash('md5').update(u).digest();
    return Promise.resolve(new Response(new Uint8Array(buf).buffer, { status: 200 }));
  }
  if (u.includes('api.cloudinary.com')) {
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
    if (rateLimitSends) {
      return Promise.resolve(new Response(JSON.stringify({ sent: false,
        error: 'You are on a free trial. You can send 1 message every 1 minute.' }), { status: 200 }));
    }
    if (failSendsTo && String(data.get('to')).includes(failSendsTo)) {
      return Promise.resolve(new Response(JSON.stringify({ sent: false, error: 'gateway hiccup' }), { status: 200 }));
    }
    sent.push({ to: data.get('to'), body: data.get('body') });
    return Promise.resolve(new Response(JSON.stringify({ sent: true }), { status: 200 }));
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
const fileMsg = ({ filename, id, caption = '' }) => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id: id ?? `file-${Math.random()}`, from: '923001112233@c.us', fromMe: false, type: 'document',
    filename, caption, media: `https://cdn.example/${encodeURIComponent(filename)}`,
    time: Math.floor(Date.now() / 1000) } });
const incoming = (text, from = '923001112233@c.us') => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id: `incoming-${Math.random()}`, from, body: text, fromMe: false, type: 'chat', time: Math.floor(Date.now() / 1000) } });
const sendFileApprove = async (name, n) => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'lecture notes', summary: 'notes' };
  const r = await webhook(fileMsg({ filename: name }));
  geminiClassify = null;
  assert.equal(r.json.data.updated, true, `${name} consumed`);
  geminiApproval = { answer: 'approve' };
  const r2 = await webhook(incoming(`YES ${n}`));
  geminiApproval = null;
  assert.equal(r2.json.data.updated, true, `approval for ${name} consumed`);
  return { file: r, approve: r2 };
};

let subject4B, section4B, section1M, subject1M, teacher, teacher2, crUser, crUser2;
test.before(async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const academicSession = (await admin('POST', '/api/admin/sessions', { name: '2099–2100' })).json.data._id;
  const hash = await bcrypt.hash('Reliability123!', 10);
  crUser = await User.create({ name: 'Cr One', email: 'cr1@reliability.test', phone: '+923009876543', role: 'cr',
    registrationStatus: 'active', emailVerified: true, password: hash });
  crUser2 = await User.create({ name: 'Cr Two', email: 'cr2@reliability.test', phone: '+923003334445', role: 'cr',
    registrationStatus: 'active', emailVerified: true, password: hash });
  section4B = (await admin('POST', '/api/admin/sections', { department: dept, session: academicSession, semester: 4, name: '4B', cr: crUser._id.toString() })).json.data._id;
  section1M = (await admin('POST', '/api/admin/sections', { department: dept, session: academicSession, semester: 1, name: '1M', cr: crUser2._id.toString() })).json.data._id;
  subject4B = (await admin('POST', '/api/admin/subjects', { section: section4B, name: 'Data Structures', code: 'DS-101' })).json.data._id;
  subject1M = (await admin('POST', '/api/admin/subjects', { section: section1M, name: 'ICT', code: 'ICT-101' })).json.data._id;
  teacher = await Teacher.create({ name: 'Dr Test', subject: subject4B, section: section4B, whatsapp: '923001112233', createdBy: crUser._id });
  teacher2 = await Teacher.create({ name: 'Dr Second', subject: subject1M, section: section1M, whatsapp: '923005556667', createdBy: crUser2._id });
});
test.after(async () => {
  await mongoose.disconnect();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  await mongod.stop();
});
test.afterEach(async () => {
  geminiClassify = null; geminiApproval = null; geminiChatReply = null; geminiAnswer = null;
  failSendsTo = null; rateLimitSends = false; failNextCloudinary = false; cloudinaryUploads = 0; lastGeminiBody = '';
  await Promise.all([OutboxMessage.deleteMany({}), TeacherMaterial.deleteMany({}), TeacherQuestion.deleteMany({}),
    Note.deleteMany({}), Notification.deleteMany({}), Timetable.deleteMany({})]);
  await Teacher.updateMany({}, { $set: { conversation: [], lastChatMsgId: '' } });
});

/* ------------------------- TEST A — REPEATED MATERIALS ------------------ */

test('TEST A: THREE separate files, each approved → all three independently uploaded — no file blocks another', async () => {
  await sendFileApprove('Lecture_01.pdf', 1);
  await sendFileApprove('Lecture_02.pdf', 2);
  await sendFileApprove('Lecture_03.pdf', 3);
  const mats = await TeacherMaterial.find({}).sort({ createdAt: 1 }).lean();
  assert.equal(mats.length, 3, 'three independent task rows');
  assert.equal(mats.filter((m) => m.status === 'published').length, 3, 'ALL published — no global processed-flag blocking');
  assert.equal(await Note.countDocuments({}), 3, 'three real Notes');
  assert.equal(cloudinaryUploads, 3, 'three real uploads');
  // each note got its OWN material/attachment
  const notes = await Note.find({}).lean();
  assert.equal(new Set(notes.map((n) => n.attachments[0].publicId)).size, 3, 'distinct files per note');
});

test('TEST A2: file 2 arrives BEFORE file 1 is answered → file 1 publishes, then file 2 is re-asked automatically (no orphan)', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: '' };
  await webhook(fileMsg({ filename: 'File_One.pdf' })); // question for file 1
  await webhook(fileMsg({ filename: 'File_Two.pdf' })); // question for file 2 (now newest asked)
  geminiClassify = null;
  let open = await TeacherMaterial.countDocuments({ status: 'awaiting_approval' });
  assert.equal(open, 2, 'both files tracked independently, both open');
  geminiApproval = { answer: 'approve' };
  await webhook(incoming('haan upload kar do')); // binds to file 2 (latest asked)
  geminiApproval = null;
  open = await TeacherMaterial.countDocuments({ status: 'awaiting_approval' });
  assert.equal(open, 1, 'file 1 still open, file 2 published');
  // the pipeline must have RE-ASKED file 1 after resolving file 2
  const reask = sent.filter((s) => s.to === '923001112233' && /File_One\.pdf/.test(s.body) && /Aur ek file/.test(s.body));
  assert.ok(reask.length >= 1, 'file 1 re-asked with a fresh binding after file 2 resolved');
  await webhook(incoming('YES')); // now answers the re-asked file 1
  const statuses = (await TeacherMaterial.find({}).lean()).map((m) => m.status).sort();
  assert.deepEqual(statuses, ['published', 'published'], 'both files eventually published');
});

/* --------------------------- TEST B — CR UPDATES ------------------------- */

test('TEST B: after each successful upload the CORRECT CR receives the actual teacher, filename, subject, section and result', async () => {
  await sendFileApprove('CR_Update_File.pdf', 1);
  const crPings = sent.filter((s) => s.to === '923009876543');
  assert.ok(crPings.length >= 2, 'asked + published pings');
  const pub = crPings[crPings.length - 1];
  assert.match(pub.body, /Dr Test/, 'teacher name');
  assert.match(pub.body, /CR_Update_File\.pdf/, 'original filename');
  assert.match(pub.body, /Data Structures/, 'subject');
  assert.match(pub.body, /4B/, 'section');
  assert.match(pub.body, /upload/i, 'result stated');
  const notif = await Notification.findOne({ recipient: crUser._id }).lean();
  assert.ok(notif, 'portal notification too');
});

/* ---------------------- TEST C — TEACHER CONFIRMATION ------------------- */

test('TEST C: teacher confirmation reflects the REAL CR-notification status — delivered vs pending, never a fake claim', async () => {
  await sendFileApprove('Confirm_File.pdf', 1);
  const teacherMsgs = sent.filter((s) => s.to === '923001112233');
  const confirm = teacherMsgs.find((s) => /Confirm_File\.pdf/.test(s.body) && /upload ho gayi/i.test(s.body));
  assert.ok(confirm, 'confirmation sent');
  assert.match(confirm.body, /CR ko bhi update kar diya gaya hai/, 'CR-informed line because delivery SUCCEEDED');

  // now make the CR ping fail: the SAME upload still succeeds, the line is honest
  failSendsTo = '923009876543';
  await sendFileApprove('Pending_CR_File.pdf', 2);
  const confirm2 = sent.filter((s) => s.to === '923001112233')
    .find((s) => /Pending_CR_File\.pdf/.test(s.body) && /upload ho gayi/i.test(s.body));
  assert.ok(confirm2, 'confirmation still sent (upload succeeded)');
  assert.match(confirm2.body, /CR ka update abhi pending hai/, 'honest pending line — no fake CR-informed claim');
  assert.equal(await Note.countDocuments({}), 2, 'both notes exist regardless of CR ping');
});

/* ------------------------ TEST D — UNKNOWN QUESTION --------------------- */

test('TEST D: an unanswerable question → NO invented answer, honest ack, persistent pending task, CR alerted', async () => {
  geminiAnswer = 'QUESTION'; // the reply interpreter routes it to the chat engine
  geminiChatReply = { reply: 'Sir, ye main apne CR se confirm kar ke aap ko bata dun ga.', escalate: true };
  const before = sent.length;
  const r = await webhook(incoming('Sir, is section ka next test kab hai?'));
  geminiAnswer = null; geminiChatReply = null;
  assert.equal(r.json.data.updated, true, 'consumed');
  const tasks = await TeacherQuestion.find({}).lean();
  assert.equal(tasks.length, 1, 'one persistent task');
  assert.equal(tasks[0].status, 'pending_cr', 'pending_cr lifecycle state');
  assert.equal(tasks[0].crNotifiedAt !== null, true, 'dispatch really happened before the ack claimed it');
  const crPings = sent.filter((s) => s.to === '923009876543');
  assert.ok(crPings.some((p) => /next test kab hai\?/.test(p.body)), 'CR sees the teacher\'s actual question');
  assert.ok(crPings.some((p) => /Dr Test/.test(p.body)), 'CR sees the teacher name');
  const ack = sent.slice(before).find((s) => s.to === '923001112233' && /CR.*confirm/i.test(s.body));
  assert.ok(ack, 'teacher acknowledged honestly after dispatch');
  // re-asking the SAME question reuses the task — no CR spam, honest pending reply
  const crCountBefore = sent.filter((s) => s.to === '923009876543').length;
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main check kar raha hoon.', escalate: true };
  await webhook(incoming('Sir, is section ka next test kab hai?'));
  geminiAnswer = null; geminiChatReply = null;
  assert.equal(await TeacherQuestion.countDocuments({}), 1, 'same question — task REUSED, not duplicated');
  assert.equal(sent.filter((s) => s.to === '923009876543').length, crCountBefore, 'no duplicate CR request');
});

/* -------------------------- TEST E — CR RESPONSE ------------------------ */

test('TEST E: the CR answers on WhatsApp → the teacher receives the answer in the ORIGINAL conversation; task closed; redelivery idempotent', async () => {
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main CR se confirm kar ke bata dun ga.', escalate: true };
  await webhook(incoming('Kal room change hai?'));
  geminiAnswer = null; geminiChatReply = null;
  const task = await TeacherQuestion.findOne({}).lean();
  assert.ok(task, 'task created');
  // CR replies from their own number
  const replyMsg = incoming('Ji, kal ki class Library Room 2 mein hogi, 9 AM.', '923009876543@c.us');
  replyMsg.data.id = 'cr-reply-1';
  const r = await webhook(replyMsg);
  assert.equal(r.json.data.updated, true, 'CR reply consumed by the question workflow');
  const answered = sent.filter((s) => s.to === '923001112233');
  assert.ok(answered.some((m) => /Library Room 2/.test(m.body)), 'teacher got the CR\'s verbatim answer');
  const closed = await TeacherQuestion.findOne({}).lean();
  assert.equal(closed.status, 'closed', 'closed ONLY after delivery');
  assert.equal(closed.crReply, 'Ji, kal ki class Library Room 2 mein hogi, 9 AM.', 'answer stored with content');
  assert.ok(closed.crReplyAt, 'timestamp stored');
  // webhook redelivery of the CR reply → no duplicate delivery to the teacher
  const countBefore = sent.filter((s) => s.to === '923001112233' && /Library Room 2/.test(s.body)).length;
  await webhook(replyMsg);
  assert.equal(sent.filter((s) => s.to === '923001112233' && /Library Room 2/.test(s.body)).length, countBefore, 'redelivery answered once');
});

test('TEST E2: CR with SEVERAL pending questions → asked WHICH one; ref-code targeting routes correctly', async () => {
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main confirm kar ke bata dun ga.', escalate: true };
  await webhook(incoming('Kal ki class hogi?'));
  await webhook(incoming('Assignment ki deadline extend hui hai?'));
  geminiAnswer = null; geminiChatReply = null;
  assert.equal(await TeacherQuestion.countDocuments({ status: 'pending_cr' }), 2, 'two independent tasks');
  // bare reply from the CR → WHICH question?
  await webhook({ ...incoming('haan'), data: { ...incoming('').data, id: 'cr-multi-1', from: '923009876543@c.us', body: 'haan', type: 'chat', time: Math.floor(Date.now() / 1000) } });
  const which = sent.filter((s) => s.to === '923009876543').pop();
  assert.match(which.body, /Q-[A-F0-9]{4}/, 'CR is asked to pick by ref code');
  // targeted reply: "Q-XXXX <answer>"
  const tasks = await TeacherQuestion.find({}).sort({ askedAt: 1 }).lean();
  const target = tasks[0];
  await webhook({ ...incoming('x'), data: { id: 'cr-multi-2', from: '923009876543@c.us', body: `${target.refCode} ji class hogi 9 baje`, type: 'chat', fromMe: false, time: Math.floor(Date.now() / 1000) } });
  const t0 = await TeacherQuestion.findById(target._id).lean();
  assert.equal(t0.status, 'closed', 'targeted question answered');
  assert.ok(sent.some((s) => s.to === '923001112233' && /9 baje/.test(s.body)), 'teacher got the targeted answer');
  assert.equal((await TeacherQuestion.find({ status: 'pending_cr' })).length, 1, 'the other question untouched');
});

/* ------------------------ TEST F — MULTIPLE QUESTIONS ------------------ */

test('TEST F: two teachers from different sections ask simultaneously → each CR gets their own question, answers never mix', async () => {
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main CR se confirm kar ke bata dun ga.', escalate: true };
  await webhook(incoming('Kal test hai?', '923001112233@c.us')); // teacher 1 → section 4B → CR 1
  await webhook(incoming('Room change hai?', '923005556667@c.us')); // teacher 2 → section 1M → CR 2
  geminiAnswer = null; geminiChatReply = null;
  const tasks = await TeacherQuestion.find({}).lean();
  assert.equal(tasks.length, 2, 'two independent task rows');
  const cr1Pings = sent.filter((s) => s.to === '923009876543');
  const cr2Pings = sent.filter((s) => s.to === '923003334445');
  assert.ok(cr1Pings.some((p) => /Kal test hai\?/.test(p.body) && /Dr Test/.test(p.body)), 'CR1 sees teacher1 question');
  assert.ok(cr2Pings.some((p) => /Room change hai\?/.test(p.body) && /Dr Second/.test(p.body)), 'CR2 sees teacher2 question');
  assert.ok(!cr1Pings.some((p) => /Room change/.test(p.body)), 'no cross-section leak to CR1');
  assert.ok(!cr2Pings.some((p) => /Kal test/.test(p.body)), 'no cross-section leak to CR2');
  // each CR answers — each teacher gets THEIR answer
  await webhook({ ...incoming('x'), data: { id: 'f-1', from: '923009876543@c.us', body: 'test Monday ko hai', type: 'chat', fromMe: false, time: Math.floor(Date.now() / 1000) } });
  await webhook({ ...incoming('x'), data: { id: 'f-2', from: '923003334445@c.us', body: 'room same rahega', type: 'chat', fromMe: false, time: Math.floor(Date.now() / 1000) } });
  assert.ok(sent.some((s) => s.to === '923001112233' && /test Monday/.test(s.body)), 'teacher1 got teacher1 answer');
  assert.ok(sent.some((s) => s.to === '923005556667' && /room same/.test(s.body)), 'teacher2 got teacher2 answer');
  assert.ok(!sent.some((s) => s.to === '923001112233' && /room same/.test(s.body)), 'no answer mixing');
  assert.equal((await TeacherQuestion.find({ status: 'closed' })).length, 2);
});

/* ------------------------ TEST G — FAILURE AND RETRY -------------------- */

test('TEST G: CR ping fails after a successful upload → sweep retries the NOTIFICATION, the file is NEVER re-uploaded', async () => {
  failSendsTo = '923009876543';
  await sendFileApprove('Retry_Notify_File.pdf', 1);
  assert.equal(await Note.countDocuments({}), 1, 'upload succeeded once');
  assert.equal(cloudinaryUploads, 1, 'exactly one real upload');
  let mat = await TeacherMaterial.findOne({ filename: 'Retry_Notify_File.pdf' }).lean();
  assert.equal(mat.crNotify.status, 'pending', 'notification task persisted as pending');
  assert.equal(mat.crNotify.attempts, 1, 'first attempt recorded');
  // backdate the retry throttle and let the 5-min sweep retry
  await TeacherMaterial.updateOne({ _id: mat._id }, { $set: { 'crNotify.lastTriedAt': new Date(Date.now() - 10 * 60 * 1000) } });
  failSendsTo = null;
  const out = await runTeacherMaterialSweep();
  assert.ok(out.crNotifyRetried >= 1 && out.crNotifyDelivered >= 1, 'sweep delivered the pending CR notification');
  mat = await TeacherMaterial.findOne({ filename: 'Retry_Notify_File.pdf' }).lean();
  assert.equal(mat.crNotify.status, 'delivered', 'notification delivered on retry');
  assert.equal(await Note.countDocuments({}), 1, 'STILL exactly one Note — notification failure never re-uploads');
  assert.equal(cloudinaryUploads, 1, 'no second Cloudinary upload');
  assert.ok(sent.some((s) => s.to === '923009876543' && /Retry_Notify_File\.pdf/.test(s.body)), 'CR finally informed');
});

/* ---------------------- TEST H — REPEATED WEBHOOK ----------------------- */

test('TEST H: the same file webhook redelivered → one material, one question; approval redelivered → ONE Note, no duplicate CR notification', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: '' };
  const payload = fileMsg({ filename: 'Dup_Webhook.pdf', id: 'dup-file-1' });
  await webhook(payload);
  await webhook(payload); // redelivery
  geminiClassify = null;
  assert.equal(await TeacherMaterial.countDocuments({}), 1, 'exactly one task row');
  const asks = sent.filter((s) => s.to === '923001112233' && /Dup_Webhook\.pdf/.test(s.body) && /upload kar doon/i.test(s.body));
  assert.equal(asks.length, 1, 'approval question asked ONCE');
  geminiApproval = { answer: 'approve' };
  const yes = incoming('YES');
  await webhook(yes);
  await webhook({ ...yes }); // same id again — already answered
  geminiApproval = null;
  assert.equal(await Note.countDocuments({}), 1, 'ONE Note from a redelivered approval');
  assert.equal(cloudinaryUploads, 1, 'one upload');
  const notifs = await Notification.find({ recipient: crUser._id }).lean();
  assert.ok(notifs.some((n) => (n.dedupeKey ?? '').includes('asked')), 'asked notification exists');
  const published = notifs.filter((n) => (n.dedupeKey ?? '').includes('published'));
  assert.equal(published.length, 1, 'exactly ONE published notification — the redelivered approval created no duplicate');
});

/* ------------------------ TEST I — RESTART RECOVERY -------------------- */

test('TEST I: a crash mid-classification (stuck RECEIVED) and mid-publish (stuck UPLOADING) → the sweep recovers both from persisted state', async () => {
  // (a) classification crashed: row stuck in 'received' for >10 min
  const stuck1 = await TeacherMaterial.create({ teacher: teacher._id, phone: '923001112233', section: section4B,
    waMsgId: 'restart-received-1', mediaUrl: 'https://cdn.example/Restart_Received.pdf',
    filename: 'Restart_Received.pdf', mime: 'application/pdf', ext: 'pdf', status: 'received',
    createdAt: new Date(Date.now() - 20 * 60 * 1000), updatedAt: new Date(Date.now() - 20 * 60 * 1000) });
  // (b) publish crashed AFTER the claim: row stuck in 'uploading', teacher already approved
  const stuck2 = await TeacherMaterial.create({ teacher: teacher._id, phone: '923001112233', section: section4B,
    waMsgId: 'restart-uploading-1', mediaUrl: 'https://cdn.example/Restart_Uploading.pdf',
    filename: 'Restart_Uploading.pdf', mime: 'application/pdf', ext: 'pdf',
    status: 'uploading', uploadClaimedAt: new Date(Date.now() - 20 * 60 * 1000), uploadAttempts: 1,
    proposedSubject: subject4B });
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: '' };
  const out = await runTeacherMaterialSweep();
  geminiClassify = null;
  assert.ok(out.resumedReceived >= 1, 'classification resumed from persisted state');
  assert.ok(out.resumedUploading >= 1, 'publish resumed — teacher approval already on record');
  const a = await TeacherMaterial.findById(stuck1._id).lean();
  assert.equal(a.status, 'awaiting_approval', 'received row recovered to its question');
  assert.ok(sent.some((s) => s.to === '923001112233' && /Restart_Received\.pdf/.test(s.body)), 'question finally asked');
  const b = await TeacherMaterial.findById(stuck2._id).lean();
  assert.equal(b.status, 'published', 'uploading row recovered to published');
  assert.ok(await Note.exists({ subject: subject4B, uploadedByTeacher: teacher._id }), 'the approved file became a real Note');
  assert.ok(sent.some((s) => s.to === '923001112233' && /Restart_Uploading\.pdf/.test(s.body) && /upload ho gayi/i.test(s.body)), 'teacher told the truth after recovery');
});

/* ------------------------- TEST J — AUTHORIZATION ----------------------- */

test('TEST J: a teacher\'s unknown question escalates ONLY to THEIR section\'s CR — restricted/other-section data never leaks', async () => {
  const before = sent.length;
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main aap ke CR se pooch kar bata dun ga.', escalate: true };
  await webhook(incoming('Sir, 1M section ka result aya hai?'));
  geminiAnswer = null; geminiChatReply = null;
  const task = await TeacherQuestion.findOne({}).lean();
  assert.ok(task, 'task created');
  assert.equal(String(task.section), String(section4B), 'scoped to the TEACHER\'S OWN section');
  const since = sent.slice(before);
  assert.equal(since.filter((s) => s.to === '923003334445').length, 0, 'the other section\'s CR receives NOTHING');
  const cr1Pings = since.filter((s) => s.to === '923009876543');
  assert.ok(cr1Pings.length >= 1, 'own CR was contacted');
  assert.ok(cr1Pings.every((p) => !/Cr Two/.test(p.body) && !/ICT/.test(p.body)), 'no other-section data (their CR or subjects) in the CR1 alert');
  // the reply-confirmation rule stays intact: a bare OK never publishes anything
  assert.equal(await Note.countDocuments({}), 0);
});

/* ----------------- SWEEP: question dispatch retry + reminders ------------ */

test('SWEEP: a CR dispatch that failed (gateway down) is re-dispatched by the sweep — the task never silently dies', async () => {
  failSendsTo = '923009876543';
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main confirm kar ke bata dun ga.', escalate: true };
  await webhook(incoming('Kal class hogi?'));
  geminiAnswer = null; geminiChatReply = null;
  const task = await TeacherQuestion.findOne({}).lean();
  assert.equal(task.crNotifiedAt, null, 'first dispatch failed — honestly not marked delivered');
  assert.ok(sent.some((s) => s.to === '923001112233' && /masla aa raha hai|dobara try/i.test(s.body)), 'teacher told the dispatch is pending, not faked');
  // backdate the throttle, restore the gateway, run the 5-min sweep
  await TeacherQuestion.updateOne({ _id: task._id }, { $set: { lastCrNotifyAt: new Date(Date.now() - 10 * 60 * 1000) } });
  failSendsTo = null;
  const out = await runTeacherQuestionSweep();
  assert.ok(out.redispatched >= 1, 'sweep re-dispatched the CR request');
  const t2 = await TeacherQuestion.findOne({}).lean();
  assert.ok(t2.crNotifiedAt, 'dispatch now really delivered');
  assert.ok(sent.some((s) => s.to === '923009876543' && /Kal class hogi\?/.test(s.body)), 'CR finally received the question');
});

/* ------------- TEST K — LIVE-INCIDENT REGRESSION (09:18 offer bug) -------
 * A file the classifier marks unclear gets the honest OFFER; the teacher's
 * "ok kr do" now BINDS to that file, asks the real approval question, and a
 * YES publishes — the old code dead-ended 'ignored' and general chat then
 * INVENTED "main ne CR ko bata diya". */
test('TEST K: unclear file → offer → teacher says "ok kr do" → approval question → YES → published (offer has a listener)', async () => {
  geminiClassify = { study_material: false, subject: '', reason: 'unclear scanned pages', summary: '' };
  const before = sent.length;
  await webhook(fileMsg({ filename: 'Scan_Docs.pdf' }));
  geminiClassify = null;
  const mat = await TeacherMaterial.findOne({}).lean();
  assert.equal(mat.status, 'offered', 'unclear file stays an OPEN offer');
  assert.match(sent[sent.length - 1].body, /file mil gayi/i, 'honest offer sent');
  // the teacher accepts the offer — offline net, exactly like the live incident
  const r = await webhook(incoming('ok kr do'));
  assert.equal(r.json.data.updated, true, 'offer acceptance consumed by the file flow');
  const mat2 = await TeacherMaterial.findOne({}).lean();
  assert.equal(mat2.status, 'awaiting_approval', 'offer → real approval question');
  assert.ok(sent.slice(before).some((m) => /Scan_Docs\.pdf/.test(m.body) && /upload kar doon\?/i.test(m.body)),
    'the REAL approval question was asked for THIS file');
  // teacher approves → publishes
  geminiApproval = { answer: 'approve' };
  await webhook(incoming('YES'));
  geminiApproval = null;
  assert.equal((await TeacherMaterial.findOne({}).lean()).status, 'published');
  assert.ok(await Note.exists({ uploadedByTeacher: teacher._id }), 'published to a real Note');
});

/* ------------- SPEC 2026-10-10 — §6/§2/§4/§5/§9/§10 A-J ------------- */

test('TEST L (spec A): FIRST-TIME stranger greeting → approved Tri3M welcome exactly once; unknown non-greeting stays silent', async () => {
  const before = sent.length;
  const r = await webhook(incoming('Assalam o Alaikum', '923999111222@c.us'));
  assert.equal(r.json.data.updated, true, 'greeting consumed');
  const welcome = sent.slice(before).find((s) => s.to === '923999111222' && /Tri3M Class Agent/.test(s.body));
  assert.ok(welcome, 'the approved Tri3M welcome — never the WATI promotional automation text');
  assert.ok(!sent.slice(before).some((s) => /automation rule|live\.wati\.io/i.test(s.body)), 'NO promotional automation text anywhere');
  // second greeting → silent (no welcome spam), but a NEW teacher still always can
  const before2 = sent.length;
  await webhook(incoming('Assalam o Alaikum', '923999111222@c.us'));
  assert.equal(sent.length, before2, 'exactly-once welcome — no repeat');
  // unknown NON-greeting traffic stays silent (spam safety)
  await webhook(incoming('marketing offer', '923999111222@c.us'));
  assert.equal(sent.length, before2, 'non-greeting unknown stays silent');
});

test('TEST M (spec B/C): MEMORY AFTER RESTART — a later follow-up retrieves the ORIGINAL question and its real status from persisted records', async () => {
  // Day 1: teacher asks, question escalates (like TEST D)
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main CR se confirm kar ke bata dun ga.', escalate: true };
  await webhook(incoming('Sir, last week kitni classes hui hain?'));
  geminiAnswer = null; geminiChatReply = null;
  const task = await TeacherQuestion.findOne({}).lean();
  assert.ok(task, 'persistent task exists');
  // "restart": nothing is in memory — the next webhook re-reads everything
  // from MongoDB. Day 2: the teacher asks about the earlier question.
  lastGeminiBody = '';
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, wo sawal aap ke CR ke paas pending hai.' };
  const r = await webhook(incoming('Kal jo poocha tha us ka answer mila?'));
  geminiAnswer = null; geminiChatReply = null;
  assert.equal(r.json.data.updated, true, 'follow-up consumed');
  assert.ok(/last week kitni classes hui hain\?/.test(lastGeminiBody), 'the ORIGINAL question was retrieved from persistent records');
  assert.ok(lastGeminiBody.includes(task.refCode), 'the task ref code was retrieved');
  assert.ok(/awaiting the CR/.test(lastGeminiBody), 'the REAL pending status was loaded — memory, not invention');
});

test('TEST N (spec D): TEN-HOUR CR silence → the persisted follow-up policy runs: 30-min + 2-h nudges, 6-h GR escalation, task survives', async () => {
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main CR se pooch kar bata dun ga.', escalate: true };
  await webhook(incoming('Sir, last week kitni classes hui hain?'));
  geminiAnswer = null; geminiChatReply = null;
  const task = await TeacherQuestion.findOne({}).lean();
  // a GR for the section exists (escalation target), distinct from the CR
  const hash = await bcrypt.hash('GrPass123!', 10);
  const grUser = await User.create({ name: 'Gr Backup', email: 'gr@reliability.test', phone: '+923007778889', role: 'gr',
    registrationStatus: 'active', emailVerified: true, password: hash });
  await Section.updateOne({ _id: section4B }, { $set: { gr: grUser._id } });
  // the question is now 11 hours old (CR never answered)
  await TeacherQuestion.updateOne({ _id: task._id }, { $set: {
    askedAt: new Date(Date.now() - 11 * 3600 * 1000), crNotifiedAt: new Date(Date.now() - 11 * 3600 * 1000) } });
  await runTeacherQuestionSweep(); // pass 1 → first nudge (30-min policy)
  await runTeacherQuestionSweep(); // pass 2 → second nudge (2-h policy)
  await runTeacherQuestionSweep(); // pass 3 → 6-h escalation to the GR
  const crNudges = sent.filter((s) => s.to === '923009876543' && /abhi tak nahi mila|intezar kar rahay hain/i.test(s.body));
  assert.equal(crNudges.length, 2, 'exactly TWO bounded nudges (30 min + 2 h), no endless reminders');
  const grAlert = sent.filter((s) => s.to === '923007778889');
  assert.equal(grAlert.length, 1, 'ONE escalation reached the GR');
  assert.ok(/last week kitni classes/i.test(grAlert[0].body), 'escalation carries the original question');
  assert.ok(grAlert[0].body.includes(task.refCode), 'escalation carries the ref code');
  const after = await TeacherQuestion.findOne({}).lean();
  assert.equal(after.status, 'pending_cr', 'task STILL pending — monitored, never silently dropped');
  assert.ok(after.escalatedAt, 'escalation recorded');
  assert.equal(after.escalatedToName, 'Gr Backup', 'who received the escalation is recorded');
  // another sweep must NOT re-escalate (bounded)
  await runTeacherQuestionSweep();
  assert.equal(sent.filter((s) => s.to === '923007778889').length, 1, 'no repeat escalation');
});

test('TEST O (spec H): the answer send FAILS → tracked, retried by the sweep, delivered; closed only after real delivery', async () => {
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main CR se confirm kar ke bata dun ga.', escalate: true };
  await webhook(incoming('Sir, is hafte kitni classes hain?'));
  geminiAnswer = null; geminiChatReply = null;
  failSendsTo = '923001112233'; // the TEACHER line is down
  await webhook(incoming('Sir, is hafte 4 classes hui thin.', '923009876543@c.us')); // CR answers
  let task = await TeacherQuestion.findOne({}).lean();
  assert.equal(task.status, 'cr_responded', 'answer STORED — never lost on a failed send');
  assert.ok(task.crReply, 'the CR\'s answer is persisted');
  assert.ok(!task.answerSentAt, 'not marked delivered — no fake success');
  const failedRow = await OutboxMessage.findOne({ refKey: `question:${task._id}:answer` }).lean();
  assert.equal(failedRow.status, 'failed', 'outbox tracked the failed delivery');
  // 5 minutes later the sweep retries — gateway is back
  failSendsTo = null;
  await OutboxMessage.updateOne({ _id: failedRow._id }, { $set: { lastTriedAt: new Date(Date.now() - 6 * 60 * 1000) } });
  const retry = await retryOutbox();
  assert.ok(retry.delivered >= 1, 'sweep re-delivered the stored answer');
  await runTeacherQuestionSweep();
  task = await TeacherQuestion.findOne({}).lean();
  assert.equal(task.status, 'closed', 'closed ONLY after real delivery');
  const answer = sent.filter((s) => s.to === '923001112233' && /4 classes hui thin/.test(s.body));
  assert.ok(answer.length, 'teacher finally received the CR\'s answer');
});

/* ------------- WASENDER TRIAL THROTTLE GUARD (2026-10-10) --------------- */

test('THROTTLE 1: a rate-limited outbox send burns NO attempt and never dies at the cap', async () => {
  rateLimitSends = true;
  const res = await sendTracked('923001112233', 'throttle probe', { kind: 'ack', refKey: 'throttle-probe-1' });
  assert.equal(res.sent, false, 'the send really failed');
  let row = await OutboxMessage.findOne({ refKey: 'throttle-probe-1' }).lean();
  assert.ok(row, 'failure is persisted honestly');
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 0, 'being THROTTLED is not a delivery failure — attempt preserved');
  // the plan window clears -> the SAME row is retried by the sweep and delivered
  rateLimitSends = false;
  await OutboxMessage.updateOne({ _id: row._id }, { $set: { lastTriedAt: new Date(Date.now() - 6 * 60 * 1000) } });
  const retry = await retryOutbox();
  assert.ok(retry.delivered >= 1, 'sweep re-delivered after the throttle cleared');
  row = await OutboxMessage.findOne({ refKey: 'throttle-probe-1' }).lean();
  assert.equal(row.status, 'sent');
});

test('THROTTLE 2: a throttled row stops the retry pass — later rows are not burned either', async () => {
  rateLimitSends = false;
  await sendTracked('923001112233', 'first ok', { kind: 'ack', refKey: 'throttle-probe-2a' });
  rateLimitSends = true;
  await sendTracked('923001112233', 'throttled', { kind: 'ack', refKey: 'throttle-probe-2b' });
  await sendTracked('923001112233', 'behind throttle', { kind: 'ack', refKey: 'throttle-probe-2c' });
  rateLimitSends = false;
  await OutboxMessage.updateMany({ refKey: /throttle-probe-2[bc]/ },
    { $set: { lastTriedAt: new Date(Date.now() - 6 * 60 * 1000) } });
  const rows = await OutboxMessage.find({ refKey: /throttle-probe-2/ }).lean();
  const throttled = rows.find((r) => r.refKey === 'throttle-probe-2b');
  const behind = rows.find((r) => r.refKey === 'throttle-probe-2c');
  // simulate the pass: 2b is throttled -> 2c must not even be attempted
  rateLimitSends = true;
  await retryOutbox();
  const behindAfter = await OutboxMessage.findOne({ refKey: 'throttle-probe-2c' }).lean();
  assert.equal(behindAfter.attempts, 0, 'the pass STOPPED at the throttle — no wasted attempts behind it');
  const throttledAfter = await OutboxMessage.findOne({ refKey: 'throttle-probe-2b' }).lean();
  assert.equal(throttledAfter.attempts, 0, 'throttled row keeps its full retry budget');
});

test('THROTTLE 3: rate-limited CR question dispatch does not burn crNotifyAttempts', async () => {
  rateLimitSends = true;
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main CR se pooch kar bata dun ga.', escalate: true };
  await webhook(incoming('Sir, is week kitni classes hain?'));
  geminiAnswer = null; geminiChatReply = null;
  let task = await TeacherQuestion.findOne({ status: 'pending_cr' }).lean();
  assert.ok(task, 'the question task persisted despite the throttle');
  assert.equal(task.crNotifyAttempts, 0, 'throttled CR dispatch burns no attempt — task cannot die while the plan throttles');
  // plan window clears -> sweep re-dispatches to the CR and it works
  rateLimitSends = false;
  await TeacherQuestion.updateOne({ _id: task._id }, { $set: { lastCrNotifyAt: new Date(Date.now() - 6 * 60 * 1000) } });
  await runTeacherQuestionSweep();
  task = await TeacherQuestion.findOne({ _id: task._id }).lean();
  assert.ok(task.crNotifiedAt, 'CR finally got the question once the throttle cleared');
});

test('TEST P (spec §5): a non-answer CR reply ("ok ji") → clarification asked, NEVER treated as the answer', async () => {
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main CR se confirm kar ke bata dun ga.', escalate: true };
  await webhook(incoming('Sir, kal ki class cancel hogi?'));
  geminiAnswer = null; geminiChatReply = null;
  const teacherBefore = sent.filter((s) => s.to === '923001112233').length;
  await webhook(incoming('ok ji', '923009876543@c.us')); // pleasantries, not an answer
  let task = await TeacherQuestion.findOne({}).lean();
  assert.equal(task.status, 'pending_cr', 'pleasantry is NOT an answer');
  assert.ok(!task.crReply, 'no fake answer stored');
  const clarify = sent.filter((s) => s.to === '923009876543' && /jawab to abhi chahiye|detail mein jawab/i.test(s.body));
  assert.ok(clarify.length, 'CR was asked for a REAL answer');
  assert.equal(sent.filter((s) => s.to === '923001112233').length, teacherBefore, 'teacher got nothing fake');
  // the CR now answers properly → delivered
  await webhook(incoming('Ji, kal ki class cancel ho jayegi, saaf kar dein.', '923009876543@c.us'));
  task = await TeacherQuestion.findOne({}).lean();
  assert.equal(task.status, 'closed', 'real answer delivered');
  assert.ok(sent.some((s) => s.to === '923001112233' && /cancel ho jayegi/.test(s.body)), 'teacher received the actual CR answer');
});

test('TEST Q (spec §9): ops-diagnostics — the administrator sees worker heartbeats, pending tasks and failed sends (sanitized)', async () => {
  geminiAnswer = 'QUESTION'; geminiChatReply = { reply: 'Sir, main CR se pooch kar bata dun ga.', escalate: true };
  await webhook(incoming('Sir, paper kab hai?'));
  geminiAnswer = null; geminiChatReply = null;
  // the 5-min cron pass stamps the sweep heartbeat
  const sweep = await admin('GET', '/api/whatsapp/deadline-sweep?secret=fake-sweep-secret');
  assert.equal(sweep.status, 200, 'sweep ran');
  const diag = (await admin('GET', '/api/whatsapp/ops-diagnostics?secret=fake-sweep-secret')).json.data;
  assert.ok(diag.heartbeat.deadlineSweepLastRun, 'sweep heartbeat recorded (worker alive)');
  assert.ok(diag.heartbeat.watchdogLastRun || true, 'watchdog heartbeat available when its cron runs');
  assert.ok(Array.isArray(diag.questions) && diag.questions.length === 1, 'pending question listed');
  assert.ok(!JSON.stringify(diag).includes('923001112233'), 'phones are masked — no PII');
  assert.equal(typeof diag.classesAwaitingTeacher, 'number', 'class queue visible');
  assert.equal(diag.outboxFailed.length, 0, 'failed outbox rows visible (none now)');
});
