/**
 * OWNER SPEC 2026-10-13 #2 — "Replace Generic Replies With Intelligent
 * Conversations". The full behavior contract, end-to-end through the REAL
 * handleGroupMessage pipeline (Gemini mocked, data real):
 *
 * §1 The message is CLASSIFIED before any reply is built.
 * §2 CR guidance (academic fallback) only for GENUINE unanswerable
 *    academic questions — short, context-specific, no feature list.
 * §3 Non-academic conversation gets natural engagement, never the fallback.
 * §4 Witty teasing without disrespect; distress never becomes a joke.
 * §5 Varied replies — no robotic repetition of one card.
 * §6 All existing rules preserved (mention-only, notes gate, strict
 *    student-group CR split, answerable questions answered from records).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const replset = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = replset.getUri('conversation_intent_test');
process.env.JWT_SECRET = 'test-only-jwt-secret-ci';
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
const { handleGroupMessage, casualReply, classifyGroupIntent } = chatbot;

const { Section, Subject, Note, Assignment, Timetable, ChatbotLog, ChatbotSetting, Department, AcademicSession, User, Teacher, Announcement, TeacherQuestion } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const server = app.listen(0);

const GROUP_ID = '1203630999@g.us';
const STUDENT = '923007770001';
const STUDENT2 = '923007770002';
const CR_PHONE = '923005555000';
const waSent = [];
const geminiCalls = [];
let geminiPayload = null; // canned {reply,intent,needs_cr,send_note_titles} object, or () => object
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
    const body = JSON.parse(opts.body);
    geminiCalls.push({ body });
    const resp = geminiEnvelope();
    if (!resp) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(resp), { status: 200 });
  }
  return realFetch(url, opts);
};

test.afterEach(async () => {
  waSent.length = 0; geminiCalls.length = 0; geminiPayload = null;
  chatbot.__resetGuards();
  await Promise.all([ChatbotSetting.deleteMany({}), ChatbotLog.deleteMany({}), TeacherQuestion.deleteMany({})]);
});

const nowSec = () => Math.floor(Date.now() / 1000);
let msgCounter = 0;
const nextMsgId = () => `ci-${++msgCounter}`;
const groupMsg = (body, { author = STUDENT, id = null, tagged = true } = {}) => {
  const text = tagged ? `@${process.env.ULTRAMSG_GATEWAY_PHONE} ${body}`.trim() : body;
  return { event_type: 'message_received', instanceId: 'instance123',
    data: { id: id ?? nextMsgId(), type: 'chat', fromMe: false, chatId: GROUP_ID, from: GROUP_ID,
      author: `${author}@c.us`, body: text, time: nowSec() } };
};
const groupAnswer = () => waSent.filter((s) => s.kind === 'chat' && s.params.to === GROUP_ID).map((s) => s.params.body);
const sendAgain = async (payload) => { chatbot.__resetGuards(); return handleGroupMessage(payload); };

let section, subject;
test.before(async () => {
  await Section.deleteMany({}); await Subject.deleteMany({}); await User.deleteMany({ email: /@ci-test\.local$/ });
  const dept = await Department.create({ name: 'AI Department', code: 'AID' });
  const session = await AcademicSession.create({ name: '2024-2028' });
  section = await Section.create({ name: '3M', semester: 2, department: dept._id, session: session._id,
    whatsappGroup: { id: GROUP_ID, name: 'General 3M' } });
  subject = await Subject.create({ name: 'Programming Fundamentals', code: 'PF-101', section: section._id, status: 'active', createdBy: section._id });
  const crUser = await User.create({ name: 'Ali Raza', email: 'cr@ci-test.local', password: 'Pass#12345678', role: 'cr', section: section._id, phone: CR_PHONE });
  await Section.updateOne({ _id: section._id }, { cr: crUser._id });
  await User.create({ name: 'Sara Khan', email: 'sara@ci-test.local', password: 'Pass#12345678', role: 'student', section: section._id, rollNo: 'S-001', phone: STUDENT });
  await User.create({ name: 'Bilal Ahmed', email: 'bilal@ci-test.local', password: 'Pass#12345678', role: 'student', section: section._id, rollNo: 'S-002', phone: STUDENT2 });
  await Note.create({ createdBy: section._id, author: section._id, title: 'Lecture 1 - Loops', subject: subject._id, section: section._id,
    attachments: [{ publicId: 'p1', url: 'https://res.cloudinary.com/demo/loops.pdf', mimeType: 'application/pdf', originalName: 'loops.pdf' }] });
  await Assignment.create({ createdBy: section._id, title: 'Lab Assignment 1', subject: subject._id, section: section._id,
    deadline: new Date(Date.now() + 3 * 86400000) });
  await Timetable.create({ section: section._id, subject: subject._id, date: new Intl.DateTimeFormat('en-CA',
    { timeZone: 'Asia/Karachi' }).format(new Date()), startTime: '09:00', endTime: '10:30', room: 'B-204', createdBy: section._id,
    teacherConfirmation: { status: 'confirmed', code: 'ABCDEF1234', phone: '923001119999', teacher: null } });
});

test.after(async () => {
  server.close();
  await mongoose.connection.close();
  await replset.stop();
});

/* ---------- §1 classifier unit contract ---------- */

test('CI-1: classifyGroupIntent orders intents correctly', () => {
  assert.equal(classifyGroupIntent('aaj mood off hai'), 'emotional');
  assert.equal(classifyGroupIntent('thanks bhai'), 'thanks');
  assert.equal(classifyGroupIntent('tum pagal ho'), 'teasing');
  assert.equal(classifyGroupIntervalSafe('assalam o alaikum'), 'greeting');
  assert.equal(classifyGroupIntervalSafe('kaisay ho bhai'), 'chat');
  assert.equal(classifyGroupIntervalSafe('tum kon ho?'), 'identity');
  assert.equal(classifyGroupIntervalSafe('kal ki class hai?'), 'academic');
  assert.equal(classifyGroupIntervalSafe('festival me kya khana banana chahiye'), 'nonacademic');
  // KEYWORD_RE word-boundary: 'ajeeb' is NOT 'aj' (regression of the old bug)
  assert.equal(classifyGroupIntent('kuch ajeeb baat kari'), 'nonacademic');
  // banter beats academic words ("assignment ne zinda chhora" is chat)
  assert.equal(classifyGroupIntent('assignment ne zinda chhora ya nahi'), 'chat');
  // distress beats everything
  assert.equal(classifyGroupIntent('exam me fail ho gaya, rona aa raha hai'), 'emotional');
});
function classifyGroupIntervalSafe(q) { return classifyGroupIntent(q); }

/* ---------- §3+§4 banter even fully OFFLINE (Gemini down) ---------- */

test('CI-2: "tum pagal ho" offline → witty confident comeback, never the dry card', async () => {
  geminiPayload = null; // Gemini down — the offline path must still banter
  await handleGroupMessage(groupMsg('tum pagal ho'));
  const answers = groupAnswer();
  assert.equal(answers.length, 1, 'exactly one group reply');
  const reply = answers[0];
  assert.match(reply, new RegExp(`^@${STUDENT} `), 'reply @mentions the asker');
  assert.doesNotMatch(reply, /Ye mere paas nahi hai|bore nahi hota|poochte raho|CR se poochein/i, 'never the old generic card');
  assert.doesNotMatch(reply, new RegExp(`@${CR_PHONE}`), 'banter never pings the CR');
  assert.equal(await TeacherQuestion.countDocuments({}), 0, 'no task');
  assert.ok(!waSent.some((s) => s.params.to === CR_PHONE), 'no CR DM');
  assert.ok(!waSent.some((s) => s.kind !== 'chat'), 'no file delivery');
});

test('CI-3: "tum kuch kaam ke bhi ho?" offline → witty defense, not the academic fallback', async () => {
  geminiPayload = null;
  await handleGroupMessage(groupMsg('tum kuch kaam ke bhi ho?'));
  const reply = groupAnswer().at(-1);
  assert.ok(reply, 'reply exists');
  assert.doesNotMatch(reply, /Ye mere paas nahi hai|bore nahi hota|CR se poochein|CR bhai se confirm/i, 'no academic fallback on teasing');
  assert.match(reply, /duty|24\/7|kaam|timetable yaad|notes kis ne|helper hoon|tolerate/i, 'a confident witty comeback');
});

test('CI-4: greeting + "kya haal hai" offline → natural short banter', async () => {
  geminiPayload = null;
  await handleGroupMessage(groupMsg('Tri3M, kya haal hai?'));
  const reply = groupAnswer().at(-1);
  assert.match(reply, /theek|mast|masst|haal|Full charge/i, 'a short natural haal reply');
  assert.doesNotMatch(reply, /Ye mere paas nahi hai|CR/i, 'no fallback, no CR');
  await sendAgain(groupMsg('salam Tri3M'));
  assert.match(groupAnswer().at(-1), /Wa alaikum assalam/i, 'a salaam always gets the walaikum');
});

test('CI-5: university-unrelated joke offline → engaged naturally', async () => {
  geminiPayload = null;
  await handleGroupMessage(groupMsg('bhai kal ka cricket match dekha? kya scene tha'));
  const reply = groupAnswer().at(-1);
  assert.doesNotMatch(reply, /Ye mere paas nahi hai|bore nahi hota|CR se|CR bhai|verified information/i, 'a joke is conversation, not a lookup');
  assert.match(reply, /bol|batao|sun raha|kehn|scene|theek|mast|masst|haal|Full charge|scenario|deadlines|WhatsApp/i, 'the bot engages with a natural banter pool reply');
});

/* ---------- §4 distress never becomes a joke ---------- */

test('CI-6: "aaj mood off hai" offline → warm support, ZERO jokes, no CR ping', async () => {
  geminiPayload = null;
  await handleGroupMessage(groupMsg('aaj mood off hai'));
  const reply = groupAnswer().at(-1);
  assert.match(reply, /sun raha hoon|batao|akele nahi/i, 'an empathetic engaged reply');
  assert.doesNotMatch(reply, /😂|😄|😀|🤣|😎|duty hai mujhe test karna|tolerate/i, 'zero jokes, zero teasing on distress');
  assert.doesNotMatch(reply, new RegExp(`@${CR_PHONE}`), 'no CR mention on an emotional message');
});

/* ---------- §2 academic fallback ONLY when genuinely needed ---------- */

test('CI-7: answerable academic question offline → answered from records, no CR deflection', async () => {
  geminiPayload = null;
  await handleGroupMessage(groupMsg('aaj ki class timing kya hai?'));
  const reply = groupAnswer().at(-1);
  assert.match(reply, /9:00|B-204|class/i, 'the real timetable answer');
  assert.doesNotMatch(reply, /CR se|CR bhai|verified information/i, 'records answer directly — no CR guidance');
});

test('CI-8: genuine unknown academic offline → SHORT CR pointer, no feature list, no "bore" line', async () => {
  geminiPayload = null;
  await handleGroupMessage(groupMsg('library ka late fine ka exact amount kya hai campus me?'));
  const reply = groupAnswer().at(-1);
  assert.match(reply, /verified information|CR bhai se confirm/i, 'the short honest CR pointer (owner wording)');
  assert.doesNotMatch(reply, /bore nahi hota|poochte raho|Timetable, notes, assignments, teachers|section ki maloomat/i, 'never the old feature-list card');
  assert.ok(reply.length < 120, 'concise — no paragraph dump');
});

test('CI-9: genuine unknown academic with Gemini → in-group CR mention (strict split preserved)', async () => {
  geminiPayload = { reply: 'x', intent: 'cr_needed', needs_cr: true };
  await handleGroupMessage(groupMsg('fee waiver ka last date extend hua?'));
  const reply = groupAnswer().at(-1);
  assert.match(reply, new RegExp(`@${CR_PHONE}`), 'the CR is @mentioned in the group');
  assert.equal(await TeacherQuestion.countDocuments({}), 0, 'student group asks still create NO task');
  assert.ok(!waSent.some((s) => s.params.to === CR_PHONE), 'no private CR DM');
});

/* ---------- gate: weak model may not convert banter into CR guidance ---------- */

test('CI-10: banter mis-flagged needs_cr by a weak model → NO CR ping, the reply stands', async () => {
  geminiPayload = { reply: 'Bhai, tum logon ki duty hai mujhe test karna 😂', intent: 'banter', needs_cr: true };
  await handleGroupMessage(groupMsg('tum pagal ho'));
  const reply = groupAnswer().at(-1);
  assert.doesNotMatch(reply, new RegExp(`@${CR_PHONE}`), 'needs_cr on a joke NEVER mentions the CR');
  assert.match(reply, /duty hai mujhe test karna/, 'the witty reply ships as-is');
  assert.equal(await TeacherQuestion.countDocuments({}), 0, 'no task either');
  assert.ok(!waSent.some((s) => s.params.to === CR_PHONE), 'no DM');
});

/* ---------- §5 variety ---------- */

test('CI-11: repeated similar teasing → varied replies (no robotic repetition)', async () => {
  geminiPayload = null;
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    await sendAgain(groupMsg('tum pagal ho'));
    const reply = groupAnswer().at(-1);
    assert.ok(reply, `reply ${i} exists`);
    seen.add(reply);
  }
  assert.ok(seen.size >= 2, `pool rotates across sends (got ${seen.size} distinct)`);
});

/* ---------- §6 existing rules preserved ---------- */

test('CI-12: notes gate intact — a clear request delivers, a mention does not', async () => {
  geminiPayload = null; // offline path proves the gate is backend-owned
  await handleGroupMessage(groupMsg('PF ke notes bhej do'));
  const fileSends = waSent.filter((s) => s.kind === 'document' || s.kind === 'file');
  assert.ok(fileSends.length > 0, 'clear notes request delivers the real file even offline');
  await sendAgain(groupMsg('AI ka concept samjhao'));
  assert.equal(waSent.filter((s) => s.kind === 'document' || s.kind === 'file').length, fileSends.length, 'a conceptual mention still delivers NOTHING');
  const reply = groupAnswer().at(-1);
  assert.doesNotMatch(reply, /bore nahi hota/i, 'and never the old card');
});

test('CI-13: mention-only rule intact — untagged banter stays silent', async () => {
  geminiPayload = null;
  assert.equal(await handleGroupMessage(groupMsg('tum pagal ho', { tagged: false })), true);
  assert.equal(groupAnswer().length, 0, 'untagged messages are consumed silently');
});
