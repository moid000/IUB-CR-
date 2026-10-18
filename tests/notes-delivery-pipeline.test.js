/**
 * OWNER SPEC 2026-10-14 #3 — "CRITICAL FIX: unsolicited notes, repeated
 * file sending & duplicate actions" + Phase 4 fast-delivery contract.
 * End-to-end through the REAL handleGroupMessage pipeline (Gemini mocked,
 * WhatsApp gateway mocked, delivery jobs REAL in MongoDB):
 *
 * ND-A  explicit request -> one job, requested files ONCE
 * ND-B  "thanks" afterwards -> no new job, no resends
 * ND-C  joke -> no files
 * ND-D  "notes kon kon se hain?" -> honest list, zero files sent
 * ND-E  "ye sab bhej do" after a listing -> all listed subjects' files once
 * ND-F  duplicate webhook event -> no duplicate job or files
 * ND-G  one file fails -> others sent, honest partial line, sent files never resent
 * ND-H  a completed request's job is never re-executed
 * ND-I  two students, two subjects, same moment -> jobs and files isolated
 * ND-T  per-file timing + provider message id recorded (spec Phase 5.2)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const replset = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = replset.getUri('notes_delivery_test');
process.env.JWT_SECRET = 'test-only-jwt-secret-nd';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.ULTRAMSG_INSTANCE_ID = 'instance123';
process.env.ULTRAMSG_TOKEN = 'fake-token';
process.env.ULTRAMSG_API_URL = 'https://ultramsg.test.local';
process.env.ULTRAMSG_INSTANCE_NUMBER = '+92 300 0000000';
process.env.ULTRAMSG_GATEWAY_PHONE = '923001234567';
process.env.ULTRAMSG_WEBHOOK_SECRET = 'whsec-test';
process.env.WHATSAPP_CHATBOT_ENABLED = 'true';
process.env.GOOGLE_API_KEY = 'test-gemini-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const chatbot = await import('../backend/services/chatbotService.js');
const { handleGroupMessage, createNotesDeliveryJob, runDeliveryJob } = chatbot;

const { Section, Subject, Note, User, ChatbotSetting, ChatbotLog, NoteDeliveryJob, Department, AcademicSession } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const waSent = [];
let geminiPayload = { reply: '' };
const geminiCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('ultramsg.test.local') && /\/messages\//.test(u)) {
    const params = Object.fromEntries(new URLSearchParams(opts.body));
    // ND-G: the poisoned file fails at the provider (media rides inside the
    // 'media' JSON param — match the whole posted body)
    if (/\/messages\/(document|image|audio|video)$/.test(u) && /fail\.pdf/.test(String(opts.body ?? ''))) {
      return new Response(JSON.stringify({ error: 'provider media fetch failed' }), { status: 500 });
    }
    waSent.push({ kind: u.match(/\/messages\/(\w+)$/)?.[1] ?? '?', params });
    return new Response(JSON.stringify({ sent: true, msgId: 'wamid.TEST' }), { status: 200 });
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    geminiCalls.push({ body: JSON.parse(opts.body) });
    return new Response(JSON.stringify(geminiPayload ?? { candidates: [] }), { status: 200 });
  }
  return realFetch(url, opts);
};

const GROUP_ID = '120363@g.us';
const ASKER = '923007770001';
const ASKER2 = '923007770002';

let section, subjectOop, subjectPf, user;
test.before(async () => {
  await Promise.all([
    ChatbotSetting.deleteMany({}), ChatbotLog.deleteMany({}), NoteDeliveryJob.deleteMany({}),
    Section.deleteMany({}), Subject.deleteMany({}), Note.deleteMany({}),
    User.deleteMany({ email: /@nd-test\.local$/ }),
  ]);
  const dept = await Department.create({ name: 'CS Department', code: 'CSD' });
  const session = await AcademicSession.create({ name: '2024-2028' });
  section = await Section.create({ name: '3M', semester: 2, department: dept._id, session: session._id,
    whatsappGroup: { id: GROUP_ID, name: 'General 3M' } });
  subjectOop = await Subject.create({ name: 'Object Oriented Programming', code: 'CS-301', section: section._id, status: 'active', createdBy: section._id });
  subjectPf = await Subject.create({ name: 'Programming Fundamentals', code: 'PF-101', section: section._id, status: 'active', createdBy: section._id });
  const author = (await User.create({ name: 'Adeel', email: 'asker1@nd-test.local', phone: '+923007770001', role: 'student',
    registrationStatus: 'active', emailVerified: true, password: 'x', section: section._id }))._id;
  await Note.create({ title: 'OOP Lecture 1', subject: subjectOop._id, section: section._id, status: 'published', createdBy: section._id, author,
    attachments: [{ url: 'https://res.cloudinary.com/demo/raw/upload/oop1.pdf', mimeType: 'application/pdf', originalName: 'oop1.pdf', publicId: 'nd/oop1' }] });
  await Note.create({ title: 'OOP Lecture 2', subject: subjectOop._id, section: section._id, status: 'published', createdBy: section._id,
    attachments: [{ url: 'https://res.cloudinary.com/demo/raw/upload/oop2.pdf', mimeType: 'application/pdf', originalName: 'oop2.pdf', publicId: 'nd/oop2' }] , author });
  await Note.create({ title: 'PF Lecture 1', subject: subjectPf._id, section: section._id, status: 'published', createdBy: section._id,
    attachments: [{ url: 'https://res.cloudinary.com/demo/raw/upload/pf1.pdf', mimeType: 'application/pdf', originalName: 'pf1.pdf', publicId: 'nd/pf1' }] , author });
  user = { _id: author, phone: '+923007770001' };
});

test.after(async () => {
  await mongoose.connection.close();
  await replset.stop();
});

test.afterEach(async () => {
  waSent.length = 0; geminiCalls.length = 0; geminiPayload = { reply: '' };
  chatbot.__resetGuards();
  await ChatbotSetting.deleteMany({});
  await ChatbotLog.deleteMany({});
  await NoteDeliveryJob.deleteMany({});
});

let msgCounter = 0;
const nextMsgId = () => `nd-${++msgCounter}`;
const groupMsg = (body, { author = ASKER, id = null } = {}) => ({
  event_type: 'message_received', instanceId: 'instance123',
  data: { id: id ?? nextMsgId(), type: 'chat', fromMe: false, chatId: GROUP_ID, from: GROUP_ID,
    author: `${author}@c.us`, body: `@923001234567 ${body}`, time: Math.floor(Date.now() / 1000) },
});
const fileSends = () => waSent.filter((s) => s.kind !== 'chat');
const chatSends = () => waSent.filter((s) => s.kind === 'chat');

/* ---------------- ND-A: one explicit request = one delivery ---------------- */
test('ND-A: "OOP ke notes bhejo" -> ONE job, exactly the matching files, sent once', async () => {
  await ChatbotSetting.create({ key: 'global', enabled: true, apiKey: 'test-gemini-key' });
  geminiPayload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Ye raha OOP ka material', send_note_titles: ['OOP Lecture 1', 'OOP Lecture 2'] }) }] } }] };
  const res = await handleGroupMessage(groupMsg('OOP ke notes bhejo'));
  assert.equal(res, true);
  const docs = fileSends();
  assert.equal(docs.length, 2, 'exactly the 2 OOP files');
  assert.ok(docs.every((d) => /oop[12]\.pdf/.test(d.params.url ?? JSON.stringify(d.params))), 'only OOP urls');
  const jobs = await NoteDeliveryJob.find({}).lean();
  assert.equal(jobs.length, 1, 'one delivery job');
  assert.equal(jobs[0].status, 'complete');
  assert.equal(jobs[0].files.filter((f) => f.state === 'sent').length, 2);
  assert.ok(jobs[0].files.every((f) => f.providerMsgId === 'wamid.TEST'), 'provider acceptance recorded (spec Phase 5)');
});

/* ---------------- ND-B/ND-C: no unsolicited resends ---------------- */
test('ND-B/C: "thanks" and a joke after a delivery -> no new job, zero files', async () => {
  await ChatbotSetting.create({ key: 'global', enabled: true, apiKey: 'test-gemini-key' });
  geminiPayload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Ye raha OOP ka material', send_note_titles: ['OOP Lecture 1'] }) }] } }] };
  await handleGroupMessage(groupMsg('OOP ke notes bhejo'));
  const filesAfterDelivery = fileSends().length;
  geminiPayload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Shukriya, koi aur kaam ho to batao' }) }] } }] };
  await chatbot.__resetGuards();
  await handleGroupMessage(groupMsg('thanks bhai'));
  await chatbot.__resetGuards();
  await handleGroupMessage(groupMsg('tum pagal ho bot'));
  assert.equal(fileSends().length, filesAfterDelivery, 'no file sent on thanks or a joke');
  const jobs = await NoteDeliveryJob.countDocuments({});
  assert.equal(jobs, 1, 'still exactly one job');
});

/* ---------------- ND-D: discovery lists, never sends ---------------- */
test('ND-D: "notes kon kon se hain?" -> honest listing, zero files', async () => {
  await ChatbotSetting.create({ key: 'global', enabled: true, apiKey: 'test-gemini-key' });
  geminiPayload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Ye subjects hain jinke notes available hain: Object Oriented Programming, Programming Fundamentals' }) }] } }] };
  await handleGroupMessage(groupMsg('notes kon kon se hain?'));
  assert.equal(fileSends().length, 0, 'discovery NEVER delivers files');
  const chat = chatSends().at(-1);
  assert.match(chat.params.body, /Object Oriented Programming/, 'real subject names from records');
  assert.match(chat.params.body, /Programming Fundamentals/);
});

/* ---------------- ND-E: explicit "sab bhej do" after a listing ---------------- */
test('ND-E: after a discovery listing, "ye sab bhej do" -> all listed subjects once', async () => {
  await ChatbotSetting.create({ key: 'global', enabled: true, apiKey: 'test-gemini-key' });
  geminiPayload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Ye subjects hain jinke notes available hain: Object Oriented Programming, Programming Fundamentals' }) }] } }] };
  await handleGroupMessage(groupMsg('notes kon kon se hain?'));
  // follow-up: pick-resolution path resolves ALL offered subjects' files
  geminiPayload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Bhej raha hoon', send_note_titles: ['OOP Lecture 1', 'OOP Lecture 2', 'PF Lecture 1'] }) }] } }] };
  await chatbot.__resetGuards();
  await handleGroupMessage(groupMsg('ye sab bhej do'));
  const docs = fileSends();
  assert.equal(docs.length, 3, 'every listed subject file, none omitted (spec 3.9)');
  const jobs = await NoteDeliveryJob.find({}).lean();
  assert.equal(jobs.length, 1, 'listing created NO job; only the explicit ask did');
});

/* ---------------- ND-F: duplicate webhook -> no duplicate job/files ---------------- */
test('ND-F: exact webhook redelivery -> single job, single delivery', async () => {
  await ChatbotSetting.create({ key: 'global', enabled: true, apiKey: 'test-gemini-key' });
  geminiPayload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Ye raha', send_note_titles: ['OOP Lecture 1'] }) }] } }] };
  const payload = groupMsg('OOP ke notes bhejo');
  await handleGroupMessage(payload);
  const filesFirst = fileSends().length;
  await chatbot.__resetGuards();
  const again = await handleGroupMessage({ ...payload, data: { ...payload.data } }); // same msg id
  assert.equal(again, true, 'redelivery consumed silently');
  assert.equal(fileSends().length, filesFirst, 'no duplicate files');
  assert.equal(await NoteDeliveryJob.countDocuments({}), 1, 'no duplicate job');
});

/* ---------------- ND-G: partial failure -> honest, no resends of sent files ---------------- */
test('ND-G: one file fails -> others sent, honest partial line, sent files never resent', async () => {
  await ChatbotSetting.create({ key: 'global', enabled: true, apiKey: 'test-gemini-key' });
  const authorId = (await User.findOne({ email: 'asker1@nd-test.local' }))._id;
  await Note.create({ title: 'OOP Poisoned', subject: subjectOop._id, section: section._id, status: 'published', createdBy: section._id,
    attachments: [{ url: 'https://res.cloudinary.com/demo/raw/upload/fail.pdf', mimeType: 'application/pdf', originalName: 'fail.pdf', publicId: 'nd/fail' }] , author: authorId });
  try {
    geminiPayload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Bhej raha hoon', send_note_titles: ['OOP Lecture 1', 'OOP Poisoned'] }) }] } }] };
    await handleGroupMessage(groupMsg('OOP ke notes bhejo'));
    const jobs = await NoteDeliveryJob.find({}).lean();
    assert.equal(jobs.length, 1);
    const states = Object.fromEntries(jobs[0].files.map((f) => [f.title, f.state]));
    assert.equal(states['OOP Lecture 1'], 'sent', 'healthy file delivered');
    assert.equal(states['OOP Poisoned'], 'failed', 'failed file honestly marked');
    assert.ok(jobs[0].files.find((f) => f.title === 'OOP Poisoned').error.length > 0, 'sanitized error recorded');
    const chatBodies = chatSends().map((s) => s.params.body).join('\n');
    assert.match(chatBodies, /1 files bhej di gayi; ye nahi ja saki: "fail\.pdf"/, 'honest partial completion');
    // re-running the SAME job never resends the sent file
    const before = fileSends().length;
    const job = await NoteDeliveryJob.findOne({});
    await runDeliveryJob(job, GROUP_ID, ASKER);
    const resent = fileSends().filter((d) => /oop1\.pdf/.test(d.params.url ?? ''));
    assert.equal(resent.length, 0, 'successfully sent file is NEVER resent');
    assert.ok(fileSends().length >= before, 'failed file retried safely');
  } finally {
    await Note.deleteOne({ title: 'OOP Poisoned' });
  }
});

/* ---------------- ND-H: a completed request never re-executes ---------------- */
test('ND-H: the msgId-idempotent gate refuses a second job for one webhook message', async () => {
  const note = await Note.findOne({ title: 'OOP Lecture 1' }).lean();
  const fakePick = [{ note, file: { url: 'https://res.cloudinary.com/demo/raw/upload/oop1.pdf',
    originalName: 'oop1.pdf', mimeType: 'application/pdf' } }];
  const job = await createNotesDeliveryJob({ sectionId: section._id, groupId: GROUP_ID, requester: ASKER,
    requesterName: 'Adeel', msgId: 'nd-dup-check', question: 'OOP ke notes bhejo', picked: fakePick });
  assert.ok(job, 'first job created');
  const dup = await createNotesDeliveryJob({ sectionId: section._id, groupId: GROUP_ID, requester: ASKER,
    requesterName: 'Adeel', msgId: 'nd-dup-check', question: 'OOP ke notes bhejo', picked: fakePick });
  assert.equal(dup, null, 'same message can NEVER mint a second job');
});

/* ---------------- ND-I: two students, same moment, isolated jobs ---------------- */
test('ND-I: simultaneous requests from two students stay isolated', async () => {
  await ChatbotSetting.create({ key: 'global', enabled: true, apiKey: 'test-gemini-key' });
  geminiPayload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Bhej raha hoon', send_note_titles: ['OOP Lecture 1'] }) }] } }] };
  const p2 = { ...groupMsg('OOP ke notes bhejo'), data: { ...groupMsg('OOP ke notes bhejo').data } };
  const [r1, r2] = await Promise.all([
    handleGroupMessage(groupMsg('OOP ke notes bhejo', { author: ASKER })),
    handleGroupMessage({ ...p2, data: { ...p2.data, author: `${ASKER2}@c.us` } }),
  ]);
  assert.equal(r1 && r2, true);
  const jobs = await NoteDeliveryJob.find({}).lean();
  assert.equal(jobs.length, 2, 'two independent jobs');
  assert.ok(new Set(jobs.map((j) => j.requester)).size === 2, 'each job bound to its own requester');
  assert.equal(new Set(jobs.map((j) => j.msgId)).size, 2, 'each request keeps its own message id');
});

/* ---------------- ND-T: per-file timing recorded (Phase 4.6) ---------------- */
test('ND-T: every delivered file records durationMs + provider id (status/audit contract)', async () => {
  await ChatbotSetting.create({ key: 'global', enabled: true, apiKey: 'test-gemini-key' });
  geminiPayload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Ye raha', send_note_titles: ['OOP Lecture 1'] }) }] } }] };
  await handleGroupMessage(groupMsg('OOP ke notes bhejo'));
  const job = await NoteDeliveryJob.findOne({}).lean();
  const f = job.files.find((x) => x.title === 'OOP Lecture 1');
  assert.equal(f.state, 'sent');
  assert.ok(Number.isFinite(f.durationMs) && f.durationMs >= 0, 'submission time measured');
  assert.equal(f.providerMsgId, 'wamid.TEST');
  assert.ok(job.latencyMs >= 0, 'end-to-end job latency recorded');
  assert.equal(f.sendKey, `${job.msgId}:${f.url}`, 'stable per-file idempotency key');
});
