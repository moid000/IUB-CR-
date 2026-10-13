/**
 * PRECISE NOTES INTENT & AUTOMATIC FILE DELIVERY (owner spec 2026-10-13).
 * The backend gate — not the prompt — owns file delivery:
 * - Files go out ONLY on a clear notes request or an active pick follow-up.
 * - A clear request with a determinable subject NEVER gets a question —
 *   the backend delivers the real notes directly (model proposal optional).
 * - Concept questions, jokes, thanks, stale contexts never send files.
 * - Duplicate events / repeated asks never re-send the same files.
 * Runs the REAL handleGroupMessage pipeline (Gemini mocked adversarially:
 * it tries to send files when it should not, and asks questions when it
 * should deliver — the backend must correct both).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const replset = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = replset.getUri('notes_intent_test');
process.env.JWT_SECRET = 'test-only-jwt-secret-ni';
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
const { handleGroupMessage, notesRequestIntent, resolveDirectNotes, recentlyDeliveredNotes } = chatbot;

const { Section, Subject, Note, ChatbotLog, ChatbotSetting, Department, AcademicSession } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const server = app.listen(0);
const GROUP_ID = '1203630999@g.us';
const STUDENT = '923007770001';
const waSent = [];
let geminiPayload = null;
const geminiEnvelope = () => {
  const p = typeof geminiPayload === 'function' ? geminiPayload() : geminiPayload;
  if (!p) return null;
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(p) }] } }] };
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('ultramsg.test.local') && /\/messages\//.test(u)) {
    const params = Object.fromEntries(new URLSearchParams(opts.body));
    waSent.push({ kind: u.match(/\/messages\/(\w+)$/)?.[1] ?? '?', params });
    return new Response(JSON.stringify({ sent: true }), { status: 200 });
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    const resp = geminiEnvelope();
    if (!resp) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(resp), { status: 200 });
  }
  return realFetch(url, opts);
};

test.afterEach(async () => {
  waSent.length = 0; geminiPayload = null;
  chatbot.__resetGuards();
  await Promise.all([ChatbotSetting.deleteMany({}), ChatbotLog.deleteMany({})]);
});

const nowSec = () => Math.floor(Date.now() / 1000);
let msgCounter = 0;
const groupMsg = (body, { author = STUDENT, id = null, tagged = true } = {}) => {
  const text = tagged ? `@${process.env.ULTRAMSG_GATEWAY_PHONE} ${body}`.trim() : body;
  return { event_type: 'message_received', instanceId: 'instance123',
    data: { id: id ?? `ni-${++msgCounter}`, type: 'chat', fromMe: false, chatId: GROUP_ID, from: GROUP_ID,
      author: `${author}@c.us`, body: text, time: nowSec() } };
};
const sendAgain = async (payload) => { chatbot.__resetGuards(); return handleGroupMessage(payload); };
const groupAnswers = () => waSent.filter((s) => s.kind === 'chat' && s.params.to === GROUP_ID).map((s) => s.params.body);
const filesSent = () => waSent.filter((s) => s.kind === 'document');

let section, aiSubj, pfSubj, ictSubj;
test.before(async () => {
  await Section.deleteMany({}); await Subject.deleteMany({}); await Note.deleteMany({});
  const dept = await Department.create({ name: 'AI Department', code: 'AID' });
  const session = await AcademicSession.create({ name: '2024-2028' });
  section = await Section.create({ name: '3M', semester: 2, department: dept._id, session: session._id,
    whatsappGroup: { id: GROUP_ID, name: 'General 3M' } });
  aiSubj = await Subject.create({ name: 'Artificial Intelligence', code: 'AI-201', section: section._id, status: 'active', createdBy: section._id });
  pfSubj = await Subject.create({ name: 'Programming Fundamentals', code: 'PF-101', section: section._id, status: 'active', createdBy: section._id });
  ictSubj = await Subject.create({ name: 'ICT', code: 'ICT-101', section: section._id, status: 'active', createdBy: section._id });
  await Note.create({ createdBy: section._id, author: section._id, title: 'Lecture 4 - Overfitting', subject: aiSubj._id, section: section._id,
    attachments: [{ publicId: 'ov1', url: 'https://res.cloudinary.com/demo/overfitting.pdf', mimeType: 'application/pdf', originalName: 'overfitting.pdf' }] });
  await Note.create({ createdBy: section._id, author: section._id, title: 'Lecture 5 - CNNs', subject: aiSubj._id, section: section._id,
    attachments: [{ publicId: 'cnn1', url: 'https://res.cloudinary.com/demo/cnn.pdf', mimeType: 'application/pdf', originalName: 'cnn.pdf' }] });
  await Note.create({ createdBy: section._id, author: section._id, title: 'Lecture 1 - Loops', subject: pfSubj._id, section: section._id,
    attachments: [{ publicId: 'lp1', url: 'https://res.cloudinary.com/demo/loops.pdf', mimeType: 'application/pdf', originalName: 'loops.pdf' }] });
});

test.after(async () => {
  server.close();
  await mongoose.connection.close();
  await replset.stop();
});

/* pure helpers */

test('NI-0: notesRequestIntent classification', () => {
  assert.equal(notesRequestIntent('AI ke notes send kar do'), 'clear');
  assert.equal(notesRequestIntent('PF ke notes chahiye'), 'clear');
  assert.equal(notesRequestIntent('kal wali lecture ki slides bhej do'), 'clear');
  assert.equal(notesRequestIntent('notes'), 'clear');
  assert.equal(notesRequestIntent('haan woh bhej do', true), 'followup');
  assert.equal(notesRequestIntent('haan woh bhej do', false), null, 'follow-up needs an ACTIVE offer');
  assert.equal(notesRequestIntent('AI me overfitting kya hota hai? samjhao'), null, 'concept question is not a request');
  assert.equal(notesRequestInterval_joke(), null);
  assert.equal(notesRequestIntent('thanks for the notes bro'), null, 'thanks is not a request');
  assert.equal(notesRequestIntent('kal quiz hai kya?'), null, 'unrelated question');
});
function notesRequestInterval_joke() { return notesRequestIntent('AI ka paper dekh kar hi dafa ho jana hai 😂'); }

test('NI-0b: resolveDirectNotes — subject pin, topic pin, single-subject inference, ambiguity', async () => {
  const { contextData } = chatbot;
  const ctx = { subjects: [{ name: 'Artificial Intelligence', code: 'AI-201' }, { name: 'Programming Fundamentals', code: 'PF-101' }, { name: 'ICT', code: 'ICT-101' }],
    notes: await Note.find({}).sort({ createdAt: -1 }).lean().populate('subject', 'name') };
  const data = contextData(ctx);
  const ai = resolveDirectNotes('AI ke notes bhej do', data);
  assert.ok(ai.titles.length, 'AI notes found');
  assert.ok(ai.titles.every((t) => /Overfitting|CNNs/.test(t)), 'only AI titles');
  const lec = resolveDirectNotes('AI ke lec 4 wale notes bhej do', data);
  assert.deepEqual(lec.titles, ['Lecture 4 - Overfitting'], 'lecture-number pin');
  assert.equal(resolveDirectNotes('notes bhej do', data), null, 'two subjects → one clarification allowed, no guess');
  const none = resolveDirectNotes('ICT ke notes bhej do', data);
  assert.ok(/ICT ke published notes nahi mile/.test(none.reply), 'honest no-notes for a subject without notes');
  assert.equal(none.titles.length, 0);
});

/* 1 + 2 — clear requests deliver automatically, no unnecessary questions */

test('NI-1: "AI ke notes send kar do" → delivered even when the model asks an unnecessary question', async () => {
  // ADVERSARIAL model: asks "kis subject?" although the subject IS clear
  geminiPayload = { reply: 'Kis subject ke notes chahiye?', intent: 'class_info', needs_cr: false, send_note_titles: [] };
  assert.equal(await handleGroupMessage(groupMsg('AI ke notes send kar do')), true);
  const docs = filesSent();
  assert.ok(docs.length >= 1, 'real AI files delivered without any follow-up');
  const answers = groupAnswers();
  assert.ok(!/kis subject/i.test(answers[0]), 'the unnecessary question never reaches the group');
  assert.match(answers[0], /Overfitting|CNNs|Notes — Artificial Intelligence/, 'backend-composed delivery names the notes');
});

test('NI-2: "PF ke notes bhej do" → matching PF notes for the correct section', async () => {
  geminiPayload = { reply: 'Ye raha PF ka material:', intent: 'class_info', needs_cr: false, send_note_titles: ['Lecture 1 - Loops'] };
  assert.equal(await handleGroupMessage(groupMsg('PF ke notes bhej do')), true);
  const docs = filesSent();
  assert.ok(docs.length === 1, 'exactly the PF file');
  assert.ok(/loops\.pdf/.test(JSON.stringify(docs[0].params)), 'the REAL PF note file, not a guess');
});

/* 3 — genuinely broad ask: one clarification, no files */

test('NI-3: "notes bhej do" with several subjects → ONE short subject clarification, no files', async () => {
  geminiPayload = { reply: 'Kis subject ke notes chahiye? In ke notes available hain: Artificial Intelligence, Programming Fundamentals', intent: 'class_info', needs_cr: false, send_note_titles: [] };
  assert.equal(await handleGroupMessage(groupMsg('notes bhej do')), true);
  assert.equal(filesSent().length, 0, 'nothing sent while ambiguous');
  assert.match(groupAnswers()[0], /kis subject/i, 'exactly one clarification');
});

/* 4 + 5 + 6 — no delivery without a real request */

test('NI-4: a conceptual question gets the ANSWER, never files (live "for loop" bug)', async () => {
  // ADVERSARIAL model: attaches files to a pure concept question
  geminiPayload = { reply: 'Overfitting model ka training data par sab se acha, lekin naya data par kharab perform karna hai.', intent: 'academic_help', needs_cr: false, send_note_titles: ['Lecture 4 - Overfitting'] };
  assert.equal(await handleGroupMessage(groupMsg('AI me overfitting kya hota hai? samjhao')), true);
  assert.equal(filesSent().length, 0, 'concept question never delivers files');
  assert.match(groupAnswers()[0], /Overfitting/, 'the conceptual answer itself IS delivered');
});

test('NI-5: a joke mentioning a subject never triggers files', async () => {
  geminiPayload = { reply: 'Paper dekh kar dafa hona to students ka national sport hai 😂', intent: 'banter', needs_cr: false, send_note_titles: ['Lecture 5 - CNNs'] };
  assert.equal(await handleGroupMessage(groupMsg('AI ka paper dekh kar hi dafa ho jana hai 😂')), true);
  assert.equal(filesSent().length, 0, 'no files for banter');
  assert.match(groupAnswers()[0], /sport|😂/, 'the wit stays');
});

test('NI-6: "thanks" after a delivery is social — never a resend', async () => {
  geminiPayload = { reply: 'Ye raha AI ka material:', intent: 'class_info', needs_cr: false, send_note_titles: ['Lecture 4 - Overfitting'] };
  await handleGroupMessage(groupMsg('AI ke notes bhej do'));
  const docsAfterFirst = filesSent().length;
  assert.ok(docsAfterFirst >= 1, 'first delivery happened');
  // ADVERSARIAL model tries to attach files to the thanks too
  geminiPayload = { reply: 'Anytime! Ab bas parh bhi lo 😄', intent: 'banter', needs_cr: false, send_note_titles: ['Lecture 4 - Overfitting'] };
  await sendAgain(groupMsg('thanks bro'));
  assert.equal(filesSent().length, docsAfterFirst, 'no resend on thanks');
  assert.match(groupAnswers()[1], /Anytime/, 'social reply delivered');
});

/* 7 + 8 — context: active picks resolve, stale contexts never do */

test('NI-7: an UNRELATED message long after a notes discussion never sends stale notes', async () => {
  // a 45-minute-old log with offered titles: past the 30-min pick window
  await ChatbotLog.create({ section: section._id, groupId: GROUP_ID,
    question: 'AI ke notes bhej do', reply: 'Lecture 4 - Overfitting ya Lecture 5 - CNNs?',
    offeredTitles: ['Lecture 4 - Overfitting', 'Lecture 5 - CNNs'], sentFiles: 0, source: 'gemini',
    createdAt: new Date(Date.now() - 45 * 60 * 1000) });
  // ADVERSARIAL model: attaches the stale notes to a brand-new unrelated ask
  geminiPayload = { reply: 'Kal ki classes ki main abhi bata deta hoon.', intent: 'class_info', needs_cr: false, send_note_titles: ['Lecture 4 - Overfitting'] };
  assert.equal(await handleGroupMessage(groupMsg('kal quiz hai kya?')), true);
  assert.equal(filesSent().length, 0, 'stale notes context can never deliver files');
  assert.match(groupAnswers()[0], /quiz|classes/i, 'the actual question answered');
});

test('NI-8: a CLEAR follow-up to a pending notes request delivers the right material', async () => {
  // step 1: a BROAD ask — several subjects, no subject named — the bot asks
  // (the only case where a clarification is allowed), nothing sent yet
  geminiPayload = { reply: 'Kis subject ke notes chahiye? In ke notes available hain: Artificial Intelligence, Programming Fundamentals', intent: 'class_info', needs_cr: false, send_note_titles: [] };
  await handleGroupMessage(groupMsg('notes bhej do'));
  assert.equal(filesSent().length, 0, 'offer stage sends nothing');
  // step 2: the student answers within the 30-min window
  geminiPayload = { reply: 'Ye raha:', intent: 'class_info', needs_cr: false, send_note_titles: ['Lecture 4 - Overfitting'] };
  await sendAgain(groupMsg('haan AI wali bhej do'));
  const docs = filesSent();
  assert.equal(docs.length, 1, 'the picked note delivered');
  assert.ok(/overfitting\.pdf/.test(JSON.stringify(docs[0].params)), 'the exact picked file');
});

/* 9 + 10 — idempotency and honesty */

test('NI-9: duplicate webhook delivery → exactly one reply, one file set', async () => {
  geminiPayload = { reply: 'Ye raha AI ka material:', intent: 'class_info', needs_cr: false, send_note_titles: ['Lecture 4 - Overfitting'] };
  const payload = groupMsg('AI ke notes bhej do');
  await handleGroupMessage(payload);
  await handleGroupMessage(payload); // same provider event id, redelivered
  assert.equal(groupAnswers().length, 1, 'redelivery never answers twice');
  assert.equal(filesSent().length, 1, 'files never double-send');
});

test('NI-10: no matching portal material → honest "no notes", nothing fabricated', async () => {
  geminiPayload = { reply: 'Kis subject ke notes chahiye?', intent: 'class_info', needs_cr: false, send_note_titles: [] };
  assert.equal(await handleGroupMessage(groupMsg('ICT ke notes bhej do')), true);
  assert.equal(filesSent().length, 0, 'no files when the portal has none');
  assert.match(groupAnswers()[0], /ICT ke published notes nahi mile/, 'honest no-match, no invented titles');
});

test('NI-11: the SAME ask repeated moments later never re-sends the files', async () => {
  geminiPayload = { reply: 'Ye raha AI ka material:', intent: 'class_info', needs_cr: false, send_note_titles: ['Lecture 4 - Overfitting'] };
  await handleGroupMessage(groupMsg('AI ke notes bhej do'));
  assert.ok(filesSent().length >= 1, 'first ask delivered');
  geminiPayload = { reply: 'Ye raha AI ka material:', intent: 'class_info', needs_cr: false, send_note_titles: ['Lecture 4 - Overfitting'] };
  await sendAgain(groupMsg('AI ke notes bhej do'));
  assert.equal(filesSent().length, 1, 'no duplicate delivery of the same files');
  assert.match(groupAnswers()[1], /abhi bheje hain/, 'the student is pointed to the earlier delivery');
});

test('NI-13: Gemini DOWN — a clear delivery ask still auto-delivers on the fallback path', async () => {
  geminiPayload = null; // every model 500s
  assert.equal(await handleGroupMessage(groupMsg('AI ke notes bhej do')), true);
  const docs = filesSent();
  assert.ok(docs.length >= 1, 'fallback delivers the real AI files too — no unnecessary question');
  assert.match(groupAnswers()[0], /Notes — Artificial Intelligence|Overfitting|CNNs/, 'backend-composed delivery');
});

test('NI-14: Gemini DOWN — a listing question ("kaun se hain?") still only lists', async () => {
  geminiPayload = null;
  assert.equal(await handleGroupMessage(groupMsg('AI ke notes kaun se hain?')), true);
  assert.equal(filesSent().length, 0, 'listing asks are answered with the list, not unsolicited files');
  assert.match(groupAnswers()[0], /Overfitting|CNNs/, 'the real titles listed');
});

test('NI-12: recentlyDeliveredNotes unit — question + titles must BOTH match a recent delivery', async () => {
  const logs = [{ question: 'AI ke notes bhej do', sentFiles: 2, offeredTitles: ['Lecture 4 - Overfitting'], createdAt: new Date() }];
  assert.equal(recentlyDeliveredNotes(logs, 'AI ke notes bhej do', ['Lecture 4 - Overfitting']), true);
  assert.equal(recentlyDeliveredNotes(logs, 'PF ke notes bhej do', ['Lecture 1 - Loops']), false, 'different material is a fresh delivery');
  assert.equal(recentlyDeliveredNotes([{ ...logs[0], sentFiles: 0 }], 'AI ke notes bhej do', ['Lecture 4 - Overfitting']), false, 'an offer without a real send never blocks');
});
