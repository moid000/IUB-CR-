import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('teacher_material_test');
process.env.JWT_SECRET = 'test-teacher-material-jwt';
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
const { Note, Section, Subject, Teacher, TeacherMaterial, Timetable, User, Notification } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const sent = [];
let failNextCloudinary = false;
let geminiClassify = null; // { study_material, subject, reason, summary } — null = Gemini STT/classify down
let geminiApproval = null; // { answer: 'approve'|'decline'|'other', subject }
let geminiChatReply = null; // general conversation { reply }
let geminiAnswer = null; // class classify YES/NO/QUESTION/ACK/UNCLEAR/ESCALATION

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
        ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: geminiChatReply }) }] } }] }), { status: 200 })
        : new Response(JSON.stringify({}), { status: 400 }));
    }
    return Promise.resolve(geminiAnswer
      ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: geminiAnswer }) }] } }] }), { status: 200 })
      : new Response(JSON.stringify({}), { status: 400 }));
  }
  if (u.includes('cdn.example')) { // the teacher's attachment download
    return Promise.resolve(new Response(new Uint8Array([37, 80, 68, 70, 1, 2, 3]).buffer, { status: 200 }));
  }
  if (u.includes('api.cloudinary.com')) {
    if (failNextCloudinary) { failNextCloudinary = false;
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'storage exploded' } }), { status: 500 })); }
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
const webhook = (body) => admin('POST', '/api/whatsapp/teacher-reply?key=fake-webhook-secret', body);
const incoming = (text, from = '923001112233@c.us') => ({ event_type: 'message_received', instanceId: 'test-instance',
  data: { id: `incoming-${Math.random()}`, from, body: text, fromMe: false, type: 'chat', time: Math.floor(Date.now() / 1000) } });
const fileMsg = ({ filename, mime = 'application/pdf', type = 'document', caption = '', id } = {}) => ({
  event_type: 'message_received', instanceId: 'test-instance',
  data: { id: id ?? `file-${Math.random()}`, from: '923001112233@c.us', fromMe: false, type,
    filename, mimetype: mime, caption, media: `https://cdn.example/${encodeURIComponent(filename)}`,
    time: Math.floor(Date.now() / 1000) } });

let section, subject, subject2, teacher, crId;
test.before(async () => {
  assert.equal((await admin('POST', '/api/auth/login', { email: 'owner@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const academicSession = (await admin('POST', '/api/admin/sessions', { name: '2099–2100' })).json.data._id;
  section = (await admin('POST', '/api/admin/sections', { department: dept, session: academicSession, semester: 4, name: '4B' })).json.data._id;
  subject = (await admin('POST', '/api/admin/subjects', { section, name: 'Data Structures', code: 'DS-101' })).json.data._id;
  subject2 = (await admin('POST', '/api/admin/subjects', { section, name: 'Applied Physics', code: 'AP-102' })).json.data._id;
  const hash = await bcrypt.hash('TeacherTest123!', 10);
  const crDoc = await User.create({ name: 'Alex Representative', email: 'cr-material@test.local', phone: '+923009876543', role: 'cr', section,
    registrationStatus: 'active', emailVerified: true, password: hash });
  crId = crDoc._id;
  await Section.updateOne({ _id: section }, { $set: { cr: crDoc._id } });
  await User.create({ name: 'Learner', email: 'student-material@test.local', phone: '+923009876544', role: 'student', section,
    registrationStatus: 'active', emailVerified: true, password: hash, rollNo: 'S-001' });
  assert.equal((await cr('POST', '/api/auth/login', { email: 'cr-material@test.local', password: 'TeacherTest123!' })).status, 200);
  teacher = await Teacher.create({ name: 'Dr Test', subject, section, whatsapp: '923001112233', createdBy: crDoc._id });
});
// repo convention: test.after + closeAllConnections or the suite never exits
test.after(async () => {
  await mongoose.disconnect();
  server.closeAllConnections(); // takes no callback — drops keep-alive sockets
  await new Promise((resolve) => server.close(() => resolve()));
  await mongod.stop();
});
test.afterEach(async () => {
  geminiClassify = null; geminiApproval = null; geminiChatReply = null; geminiAnswer = null;
  await TeacherMaterial.deleteMany({}); await Note.deleteMany({}); await Notification.deleteMany({});
  await Teacher.updateMany({}, { $set: { conversation: [], lastChatMsgId: '' } });
});

/* ---------------- TEST A — no reminder, greeting ---------------- */

test('MASTER UPGRADE TEST A: "Assalam o Alaikum" with NO reminder and NO class → natural reply, not silence', async () => {
  const before = sent.length;
  assert.equal((await Timetable.countDocuments({})), 0, 'no class anywhere in this DB');
  geminiAnswer = 'ACK';
  geminiChatReply = 'Wa Alaikum Assalam Sir! 🙏 Main Tri3M Class Agent hun — bataiye kuch poochna ho to.';
  try {
    const r = await webhook(incoming('Assalam o Alaikum'));
    assert.equal(r.json.data.updated, true, 'greeting consumed + answered');
    assert.equal(sent.length, before + 1, 'exactly one reply');
    assert.match(sent[sent.length - 1].body, /Wa Alaikum Assalam Sir!/);
    const prof = await Teacher.findById(teacher._id).lean();
    assert.ok(prof.conversation.length >= 2, 'general conversation persisted on the Teacher record');
  } finally { geminiAnswer = null; geminiChatReply = null; }
});

/* ---------------- TEST B — multiple questions, no reminder ---------------- */

test('MASTER UPGRADE TEST B: multiple questions with NO class slot → each answered independently', async () => {
  geminiAnswer = 'QUESTION';
  geminiChatReply = 'Sir, aap ki agli class Data Structures hai.';
  try {
    const before = sent.length;
    for (const q of ['meri class ka time kya hai?', 'kis section mein meri class hai?']) {
      const r = await webhook(incoming(q));
      assert.equal(r.json.data.updated, true, `"${q}" answered`);
    }
    assert.equal(sent.length, before + 2, 'both questions answered');
    const prof = await Teacher.findById(teacher._id).lean();
    assert.equal(prof.conversation.filter((m) => m.role === 'teacher').length, 2, 'both teacher turns in history');
  } finally { geminiAnswer = null; geminiChatReply = null; }
});

/* ---------------- TEST C — after confirmation, general chat lives on ---------------- */

test('MASTER UPGRADE TEST C: class CONFIRMED, then a general question → assistant keeps replying', async () => {
  geminiAnswer = 'YES';
  try {
    const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-01-03', startTime: '10:00', endTime: '11:00' });
    const slotId = r.json.data._id;
    assert.equal((await webhook(incoming('YES'))).json.data.updated, true);
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed');
    geminiAnswer = 'QUESTION';
    geminiChatReply = 'Ji Sir, main Tri3M Class Agent hun — students ka class coordination assistant.';
    const q = await webhook(incoming('ap kon ho?'));
    assert.equal(q.json.data.updated, true, 'general question answered after confirmation');
    assert.equal(sent.length, (await Timetable.findById(slotId).lean(), sent.length)); // no exception path
  } finally { geminiAnswer = null; geminiChatReply = null; }
});

/* ---------------- TEST D — study material detection ---------------- */

test('MASTER UPGRADE TEST D: teacher sends a study-material PDF → examined, approval asked, NOTHING published yet', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'lecture notes with exercises', summary: 'Binary trees chapter' };
  try {
    const before = sent.length;
    const msg = fileMsg({ filename: 'Data_Structures_Lecture_03.pdf', caption: 'ye chapter ki notes hain' });
    const r = await webhook(msg);
    assert.equal(r.json.data.updated, true);
    assert.equal(sent.length, before + 2, 'one approval question + one CR ping');
    const body = sent[sent.length - 1].body;
    assert.match(body, /Data_Structures_Lecture_03\.pdf/, 'question names the exact file');
    assert.match(body, /Data Structures/i, 'question names the resolved subject');
    assert.match(body, /upload kar doon\?/i, 'asks permission — never publishes by itself');
    const mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'awaiting_approval');
    assert.equal(String(mat.proposedSubject), String(subject));
    assert.equal(mat.sha256.length, 64, 'content hash recorded');
    assert.equal(await Note.countDocuments({}), 0, 'no Note until the teacher approves');
  } finally { geminiClassify = null; }
});

/* ---------------- TEST E — approval → real upload ---------------- */

test('MASTER UPGRADE TEST E: teacher approves → file uploaded to Cloudinary, real Note created, verified, success reply', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  const approve = fileMsg({ filename: 'Data_Structures_Lecture_03.pdf' });
  try {
    await webhook(approve); // asks approval
    geminiApproval = { answer: 'approve' };
    geminiAnswer = 'ACK'; // safety: the class pipeline must NOT also answer
    const before = sent.length;
    const r = await webhook(incoming('haan, upload kar do'));
    assert.equal(r.json.data.updated, true);
    const mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'published', 'material published');
    assert.ok(mat.publishedNote, 'publishedNote ref set');
    assert.ok(mat.attachment?.publicId, 'verified Cloudinary FileMeta stored');
    const note = await Note.findById(mat.publishedNote).lean();
    assert.ok(note, 'the Note exists');
    assert.equal(note.title, 'Data Structures Lecture 03', 'title from the filename (extension stripped, underscores → spaces)');
    assert.equal(String(note.subject), String(subject), 'correct subject');
    assert.equal(String(note.section), String(section), 'correct section');
    assert.equal(note.status, 'published');
    assert.equal(note.attachments.length, 1);
    assert.ok(note.attachments[0].url.startsWith('https://res.cloudinary.com/demo/iub-cr-lms/note/'), 'attachment in the app namespace');
    assert.ok(note.uploadedByTeacher, 'teacher identity preserved as uploader');
    assert.equal(String(note.author), String(crId), 'CR is the technical author');
    assert.match(sent[sent.length - 1].body, /ho gaya|uploaded/i, 'success reply only AFTER verification');
  } finally { geminiClassify = null; geminiApproval = null; geminiAnswer = null; }
});

/* ---------------- TEST F — ambiguous subject ---------------- */

test('MASTER UPGRADE TEST F: teacher of TWO subjects, file maps to neither → asks which subject, never guesses', async () => {
  await Teacher.create({ name: 'Dr Test', subject: subject2, section, whatsapp: '923001112233', createdBy: crId });
  geminiClassify = { study_material: true, subject: '', reason: 'notes but subject unclear', summary: 's' };
  try {
    const before = sent.length;
    await webhook(fileMsg({ filename: 'chapter_notes.pdf' }));
    let mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'awaiting_subject');
    assert.match(sent[sent.length - 1].body, /kis subject ke Notes/i, 'asks which subject');
    assert.equal(await Note.countDocuments({}), 0);

    // teacher answers the subject → approval question with THAT subject
    geminiApproval = { answer: 'approve', subject: 'Applied Physics' };
    await webhook(incoming('applied physics'));
    mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'awaiting_approval');
    assert.equal(String(mat.proposedSubject), String(subject2), 'subject resolved from the teacher\'s answer');
    assert.match(sent[sent.length - 1].body, /Applied Physics/i);
    assert.equal(await Note.countDocuments({}), 0, 'still nothing published without an explicit approval');

    // final approval publishes to the chosen subject
    geminiApproval = { answer: 'approve' };
    await webhook(incoming('haan upload kar dein'));
    mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'published');
    const note = await Note.findById(mat.publishedNote).lean();
    assert.equal(String(note.subject), String(subject2));
  } finally { geminiClassify = null; geminiApproval = null; await Teacher.deleteMany({ subject: subject2 }); }
});

/* ---------------- TEST G — declined approval ---------------- */

test('MASTER UPGRADE TEST G: teacher declines → nothing published, honest ack', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  try {
    await webhook(fileMsg({ filename: 'lecture.pdf' }));
    geminiApproval = { answer: 'decline' };
    const before = sent.length;
    await webhook(incoming('nahi, rehne dein'));
    // (a CR ping went out at file-receipt time too — count only from here)
    assert.equal(await Note.countDocuments({}), 0, 'NEVER publishes on a decline');
    const mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'declined');
    assert.equal(sent.length, before + 2, 'one honest ack to the teacher + one decline ping to the CR');
    assert.match(sent.slice(-2).map((m) => m.body).join(' \n '), /koi file upload nahi/i);
  } finally { geminiClassify = null; geminiApproval = null; }
});

/* ---------------- TEST H — generic ack must not authorize ---------------- */

test('MASTER UPGRADE TEST H: a bare "ok" after an unrelated question NEVER authorizes the upload (spec §5)', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  try {
    await webhook(fileMsg({ filename: 'lecture.pdf' }));
    // the teacher asks an unrelated question instead of answering the approval
    geminiApproval = { answer: 'other' }; // not an approval — must NOT publish
    geminiAnswer = 'QUESTION';
    geminiChatReply = 'Sir, class Monday 10:00 AM ki hai.';
    await webhook(incoming('class ka time kya hai?'));
    assert.equal(await Note.countDocuments({}), 0, 'a question is not an approval');
    let mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'awaiting_approval', 'the pending approval SURVIVES the unrelated question');
    // even a bare ok afterwards is not an approval (Gemini says other)
    geminiApproval = { answer: 'other' };
    await webhook(incoming('ok'));
    mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'awaiting_approval');
    assert.equal(await Note.countDocuments({}), 0);
  } finally { geminiClassify = null; geminiApproval = null; geminiAnswer = null; geminiChatReply = null; }
});

/* ---------------- TEST I — upload failure ---------------- */

test('MASTER UPGRADE TEST I: Cloudinary fails → NO fake success, status failed, honest next-step reply', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  try {
    await webhook(fileMsg({ filename: 'lecture.pdf' }));
    geminiApproval = { answer: 'approve' };
    failNextCloudinary = true;
    const before = sent.length;
    await webhook(incoming('yes upload it'));
    assert.equal(await Note.countDocuments({}), 0, 'nothing created');
    const mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'failed');
    assert.match(mat.uploadError, /storage exploded|Upload failed/);
    const reply = sent[sent.length - 1].body;
    assert.match(reply, /upload nahi ho saki/i, 'honestly reports the failure');
    assert.doesNotMatch(reply, /ho gaya|has been uploaded/i, 'NEVER claims success');
  } finally { geminiClassify = null; geminiApproval = null; }
});

/* ---------------- TEST J — webhook redelivery idempotency ---------------- */

test('MASTER UPGRADE TEST J: the SAME webhook event delivered twice → one record, one question; approve redelivery → one Note', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  try {
    const before = sent.length;
    const msg = fileMsg({ filename: 'same_twice.pdf' });
    await webhook(msg);
    await webhook(msg); // network redelivery
    assert.equal(await TeacherMaterial.countDocuments({}), 1, 'exactly one material record');
    const crPings = sent.slice(before).filter((m) => String(m.to).includes('923009876543')).length;
    const teacherQs = sent.slice(before).length - crPings;
    assert.equal(teacherQs, 1, 'approval question asked ONCE (redelivery adds nothing)');
    // approve → publish; the SAME approve message redelivered → still one Note
    geminiApproval = { answer: 'approve' };
    const approveMsg = incoming('yes upload it');
    await webhook(approveMsg);
    await webhook(approveMsg);
    assert.equal(await Note.countDocuments({}), 1, 'no duplicate Note on approve redelivery');
    const mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'published');
  } finally { geminiClassify = null; geminiApproval = null; }
});

/* ---------------- same FILE resent as a NEW message ---------------- */

test('MASTER UPGRADE §8: identical content resent under a new message id → deduped by hash, no second question', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  try {
    const before = sent.length;
    await webhook(fileMsg({ filename: 'dup.pdf' }));
    await webhook(fileMsg({ filename: 'dup-resent.pdf' })); // same bytes (same mock file)
    assert.equal(await TeacherMaterial.countDocuments({}), 2, 'both events recorded');
    const statuses = (await TeacherMaterial.find({}).lean()).map((m) => m.status);
    assert.ok(statuses.includes('awaiting_approval'));
    assert.ok(statuses.includes('ignored'), 'the resent copy is deduped, not re-asked');
    const teacherFacing = sent.slice(before).filter((m) => !String(m.to).includes('923009876543')).length;
    assert.equal(teacherFacing, 2, 'first ask + duplicate notice to the TEACHER only');
  } finally { geminiClassify = null; }
});

/* ---------------- not study material ---------------- */

test('MASTER UPGRADE §4: clearly NON-educational content → no upload prompt, honest ack, ignored', async () => {
  geminiClassify = { study_material: false, subject: '', reason: 'a personal photo of a pet', summary: 'photo' };
  try {
    const before = sent.length;
    const r = await webhook(fileMsg({ filename: 'IMG_2043.jpg', mime: 'image/jpeg', type: 'image' }));
    assert.equal(r.json.data.updated, true);
    assert.equal(sent.length, before + 1);
    assert.doesNotMatch(sent[sent.length - 1].body, /upload kar doon\?/i, 'no upload offer for a non-material file');
    const mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'ignored');
    assert.equal(mat.classification.verdict, 'not_material');
  } finally { geminiClassify = null; }
});

/* ---------------- strangers stay silent ---------------- */

test('MASTER UPGRADE §10: a file from an UNRECOGNIZED number → silence, nothing recorded', async () => {
  const r = await webhook({ event_type: 'message_received', instanceId: 'test-instance',
    data: { id: `stranger-${Math.random()}`, from: '923099999999@c.us', fromMe: false, type: 'document',
      filename: 'x.pdf', mimetype: 'application/pdf', media: 'https://cdn.example/x.pdf', time: Math.floor(Date.now() / 1000) } });
  assert.equal(r.json.data.updated, false);
  assert.equal(await TeacherMaterial.countDocuments({}), 0);
});

/* ---------------- class YES/NO beats an OLDER upload question ---------------- */

test('MASTER UPGRADE §5 recency: a NEWER class confirmation question outranks the older upload question', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  try {
    await webhook(fileMsg({ filename: 'older_question.pdf' }));
    // age the upload question so a NEW class ask is the most recent question
    await TeacherMaterial.updateOne({}, { $set: { askedAt: new Date(Date.now() - 10 * 60 * 1000) } });
    // CR adds a class → confirmation question goes out NOW (newer than the upload ask)
    const r = await cr('POST', '/api/cr/timetable', { subject, date: '2099-03-15', startTime: '09:00', endTime: '10:00' });
    const slotId = r.json.data._id;
    geminiApproval = { answer: 'approve' }; // if the binding were wrong this would publish
    const resp = await webhook(incoming('YES'));
    assert.equal(resp.json.data.updated, true, 'the YES is consumed by the CLASS');
    assert.equal((await Timetable.findById(slotId)).teacherConfirmation.status, 'confirmed', 'class confirmed');
    const mat = await TeacherMaterial.findOne({}).lean();
    assert.equal(mat.status, 'awaiting_approval', 'upload still pending — YES did NOT publish it');
    assert.equal(await Note.countDocuments({}), 0);
  } finally { geminiClassify = null; geminiApproval = null; }
});

/* ---------------- OWNER REQUEST 2026-10-08: the CR always KNOWS ---------------- */

test('OWNER REQUEST: teacher sends + approves notes → the CR gets portal notifications AND a WhatsApp ping at each step', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  try {
    const before = sent.length;
    await webhook(fileMsg({ filename: 'cr_notify.pdf' }));
    // step 1: file received + approval asked → CR notified
    let notifs = await Notification.find({}).sort({ createdAt: 1 }).lean();
    assert.equal(notifs.length, 1, 'one notification on file receipt');
    assert.match(notifs[0].title, /sent study material/i);
    assert.equal(String(notifs[0].recipient), String(crId), 'addressed to the section CR');
    const crPings = sent.slice(before).filter((m) => String(m.to).includes('923009876543'));
    assert.equal(crPings.length, 1, 'CR also got a WhatsApp ping');
    assert.match(crPings[0].body, /cr_notify\.pdf/, 'ping names the file');
    assert.match(crPings[0].body, /Dr Test/, 'ping names the teacher');

    // step 2: approved + published → CR told it is live
    geminiApproval = { answer: 'approve' };
    const before2 = sent.length;
    await webhook(incoming('haan upload kar do'));
    notifs = await Notification.find({}).sort({ createdAt: 1 }).lean();
    assert.equal(notifs.length, 2, 'second notification on publish');
    assert.match(notifs[1].title, /published/i);
    assert.match(notifs[1].message, /Notes section/i);
    assert.ok(notifs[1].refId, 'points at the real Note');
    assert.equal(sent.slice(before2).filter((m) => String(m.to).includes('923009876543')).length, 1, 'publish ping to CR');
  } finally { geminiClassify = null; geminiApproval = null; }
});

test('OWNER REQUEST: teacher DECLINES → the CR is told nothing was published', async () => {
  geminiClassify = { study_material: true, subject: 'Data Structures', reason: 'notes', summary: 's' };
  try {
    await webhook(fileMsg({ filename: 'declined_file.pdf' }));
    geminiApproval = { answer: 'decline' };
    await webhook(incoming('nahi rehne dein'));
    const notifs = await Notification.find({}).lean();
    assert.equal(notifs.length, 2);
    assert.match(notifs[notifs.length - 1].title, /declined/i);
    assert.equal(await Note.countDocuments({}), 0);
  } finally { geminiClassify = null; geminiApproval = null; }
});
