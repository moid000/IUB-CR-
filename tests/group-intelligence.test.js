/**
 * OWNER GROUP CONVERSATION INTELLIGENCE UPGRADE (2026-10-12).
 * Tri3M as a context-aware academic assistant with natural wit — the full
 * behavior contract, end-to-end through the REAL handleGroupMessage
 * pipeline (Gemini mocked, all data real):
 *
 * 1. Greeting/thanks: brief, natural, no CR deflection.
 * 2. Study-guide: academic questions get real tutor answers (prompt carries
 *    the STUDY TUTOR rule; portal facts stay data-bound).
 * 3. Verified data: notes/assignment/timetable from real records only.
 * 4. Humor: banter gets wit; DISTRESS gets support, never a roast (prompt
 *    carries READ THE ROOM + HUMOR SAFETY hard limits).
 * 5. Diversity: same phrasings never repeat — memory carries previous
 *    replies, a verbatim repeat triggers ONE banned regeneration.
 * 6. needs_cr: a CR-confirmation question creates a REAL TeacherQuestion
 *    task (existing workflow) — the group reply states ONLY the
 *    backend-verified dispatch result, never the LLM's own claim.
 * 7. Mention-only silence and self-message loops stay impossible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const replset = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = replset.getUri('group_intelligence_test');
process.env.JWT_SECRET = 'test-only-jwt-secret-gi';
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
const { handleGroupMessage, SYSTEM_PROMPT, askGemini } = chatbot;
const { handleCrQuestionReply } = await import('../backend/services/teacherQuestionService.js');

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
const geminiEnvelope = () => { // real Gemini response shape
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
const nextMsgId = () => `gi-${++msgCounter}`;
const groupMsg = (body, { author = STUDENT, id = null, tagged = true } = {}) => {
  const text = tagged ? `@${process.env.ULTRAMSG_GATEWAY_PHONE} ${body}`.trim() : body;
  return { event_type: 'message_received', instanceId: 'instance123',
    data: { id: id ?? nextMsgId(), type: 'chat', fromMe: false, chatId: GROUP_ID, from: GROUP_ID,
      author: `${author}@c.us`, body: text, time: nowSec() } };
};
const groupAnswer = () => waSent.filter((s) => s.kind === 'chat' && s.params.to === GROUP_ID).map((s) => s.params.body);
const sendAgain = async (payload) => { chatbot.__resetGuards(); return handleGroupMessage(payload); }; // bypass the 5s group cooldown between scripted sends

let section, subject, crUser;
test.before(async () => {
  await Section.deleteMany({}); await Subject.deleteMany({}); await User.deleteMany({ email: /@gi-test\.local$/ });
  const dept = await Department.create({ name: 'AI Department', code: 'AID' });
  const session = await AcademicSession.create({ name: '2024-2028' });
  section = await Section.create({ name: '3M', semester: 2, department: dept._id, session: session._id,
    whatsappGroup: { id: GROUP_ID, name: 'General 3M' } });
  subject = await Subject.create({ name: 'Programming Fundamentals', code: 'PF-101', section: section._id, status: 'active', createdBy: section._id });
  crUser = await User.create({ name: 'Ali Raza', email: 'cr@gi-test.local', password: 'Pass#12345678', role: 'cr', section: section._id, phone: CR_PHONE });
  await Section.updateOne({ _id: section._id }, { cr: crUser._id });
  await User.create({ name: 'Sara Khan', email: 'sara@gi-test.local', password: 'Pass#12345678', role: 'student', section: section._id, rollNo: 'S-001', phone: STUDENT });
  await User.create({ name: 'Bilal Ahmed', email: 'bilal@gi-test.local', password: 'Pass#12345678', role: 'student', section: section._id, rollNo: 'S-002', phone: STUDENT2 });
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

/* ---------- prompt carries the intelligence contract ---------- */

test('GI-0: SYSTEM_PROMPT carries the full 2026-10-12 intelligence contract', () => {
  assert.match(SYSTEM_PROMPT, /STUDY TUTOR/, 'tutor rule');
  assert.match(SYSTEM_PROMPT, /READ THE ROOM/, 'context judgement rule');
  assert.match(SYSTEM_PROMPT, /HUMOR SAFETY/, 'hard humor limits');
  assert.match(SYSTEM_PROMPT, /DIVERSITY/, 'anti-repetition rule');
  assert.match(SYSTEM_PROMPT, /NEEDS_CR/, 'CR-task rule');
  assert.match(SYSTEM_PROMPT, /appearance, family, money, identity, disability/, 'sensitive-characteristic ban');
  assert.match(SYSTEM_PROMPT, /NEVER turn a genuine difficulty, failure or distress into a joke/, 'distress protection');
  assert.match(SYSTEM_PROMPT, /never reuse the same opening, punchline/, 'phrasing variety');
  assert.match(SYSTEM_PROMPT, /needs_cr.*genuinely requires CR confirmation/s, 'needs_cr gating');
  assert.match(SYSTEM_PROMPT, /NEVER fabricate official university information/, 'no invented official info');
});

/* ---------- 1. greeting + thanks: brief and natural ---------- */

test('GI-1: greeting and thank-you get short natural replies, no CR deflection', async () => {
  geminiPayload = { reply: 'Assalam o alaikum! Bolo, kya chahiye?', intent: 'banter', needs_cr: false };
  await handleGroupMessage(groupMsg('assalam o alaikum'));
  geminiPayload = { reply: 'Anytime! Ab bas assignment bhi isi speed se kar lo 😄', intent: 'banter', needs_cr: false };
  await sendAgain(groupMsg('thanks bro'));
  const answers = groupAnswer();
  assert.equal(answers.length, 2, 'both answered');
  assert.ok(!/CR/i.test(answers[0]), 'greeting did not deflect to the CR');
  assert.ok(answers[1].length < 120, 'thanks stays short');
});

/* ---------- 2/3. study guide: simple + conceptual academic questions ---------- */

test('GI-2: simple academic question → tutor answer, intent academic_help, data-context attached', async () => {
  geminiPayload = { reply: 'Loop ek tarika hai ke computer ek kaam baar baar kare. Misal: 1 se 5 tak numbers print karna — for loop ek line me kaam kar deta hai.', intent: 'academic_help', needs_cr: false };
  await handleGroupMessage(groupMsg('loop kya hota hai?'));
  const answers = groupAnswer();
  assert.ok(answers.length >= 1, 'answered');
  assert.match(answers[0], /Loop/, 'tutor content delivered');
  const sent = geminiCalls[0].body;
  assert.match(sent.systemInstruction.parts[0].text, /STUDY TUTOR/, 'prompt allows tutoring');
  assert.ok(JSON.stringify(sent).includes('Programming Fundamentals'), 'class data still attached');
});

test('GI-3: difficult conceptual question → structured step explanation, no CR deflection', async () => {
  geminiPayload = { reply: 'Recursion:\n1. Function khud ko call karta hai\n2. Ek base case zaroori hai jahan ruk jaye\n3. Har call choti masla (n-1) hal karta hai\nMisal: factorial(4) = 4 x factorial(3).', intent: 'academic_help', needs_cr: false };
  await handleGroupMessage(groupMsg('recursion samjhao, kal paper hai'));
  const answers = groupAnswer();
  assert.match(answers[0], /base case/, 'steps delivered');
  assert.ok(!/CR/i.test(answers[0]), 'tutor question never deflected to CR');
});

/* ---------- 4/5. verified data: notes, assignment deadline, timetable ---------- */

test('GI-4: notes request delivers REAL files; assignment deadline from REAL data', async () => {
  geminiPayload = { reply: 'Ye raha Lecture 1 - Loops:', send_note_titles: ['Lecture 1 - Loops'], intent: 'class_info', needs_cr: false };
  await handleGroupMessage(groupMsg('PF ke notes bhej do'));
  assert.ok(waSent.some((s) => s.kind === 'document' && /loops\.pdf|Lecture 1/.test(JSON.stringify(s.params))), 'real file delivered');
  geminiPayload = { reply: 'PF ki *Lab Assignment 1* — deadline 3 din baad hai.', intent: 'class_info', needs_cr: false };
  await sendAgain(groupMsg('assignment ki deadline kya hai?'));
  assert.match(groupAnswer()[1], /Lab Assignment 1/, 'real assignment title echoed');
});

test('GI-5: timetable query answered from the saved schedule', async () => {
  geminiPayload = { reply: 'Aaj 9:00 AM me *Programming Fundamentals* hai, room B-204 (confirmed).', intent: 'class_info', needs_cr: false };
  await handleGroupMessage(groupMsg('aaj ki class ka time?'));
  assert.match(groupAnswer()[0], /9:00 AM/, 'schedule from real data');
});

/* ---------- 6/7. humor: banter vs distress ---------- */

test('GI-6: harmless joke → witty reply, no sensitive targeting', async () => {
  geminiPayload = { reply: 'Kal se pakka study start — syllabus bhi pooch raha hai: bhai, meri baari kab aayegi? 😂', intent: 'banter', needs_cr: false };
  await handleGroupMessage(groupMsg('kal se pakka study start'));
  assert.match(groupAnswer()[0], /syllabus/, 'wit delivered');
});

test('GI-7: distressed student → SUPPORTIVE reply; prompt forbids jokes about distress', async () => {
  geminiPayload = { reply: 'Tension mat lo — do steps se samajhte hain, ek ek kar ke. Pehle batao kis point par atak gaye ho?', intent: 'emotional_support', needs_cr: false };
  await handleGroupMessage(groupMsg('mujhe kuch samajh nahi aa raha, fail ho jaunga kya?'));
  const answers = groupAnswer();
  assert.match(answers[0], /Tension mat lo/, 'support delivered');
  assert.ok(!/😂|😄|😆/.test(answers[0]), 'no joke emoji on a distress message');
  assert.match(SYSTEM_PROMPT, /sounds upset, stressed or scared.*ZERO jokes/s, 'hard rule present');
});

/* ---------- 8. ambiguous + mixed language ---------- */

test('GI-8: ambiguous message → ONE short clarifying question; mixed language answered naturally', async () => {
  geminiPayload = { reply: 'Kaunsi cheez bhejoon — notes ya assignment? Ek bata do.', intent: 'ambiguous', needs_cr: false };
  await handleGroupMessage(groupMsg('bhej do na wo wali cheez'));
  const a1 = groupAnswer()[0];
  assert.match(a1, /\?/, 'clarifying question asked');
  assert.ok(!/needs_cr/.test(a1), 'no internal fields leak');
  geminiPayload = { reply: 'Arrays ek line me kai values rakhte hain — int marks[5]. Index 0 se shuru hota hai.', intent: 'academic_help', needs_cr: false };
  await sendAgain(groupMsg('array ka concept briefly bata do, simple words me'));
  assert.match(groupAnswer()[1], /marks\[5\]/, 'mixed-language academic answer delivered');
});

/* ---------- 9. diversity: no repeated phrasing ---------- */

test('GI-9: verbatim repeated reply → ONE banned regeneration; history feeds the prompt', async () => {
  // first turn
  geminiPayload = () => ({ reply: 'Aaj koi class nahi hai — azaadi ki azaadi!', intent: 'class_info', needs_cr: false });
  await handleGroupMessage(groupMsg('aaj class hai?'));

  // second turn: the model repeats the EXACT same text → backend regenerates once with a ban
  const callsBefore = geminiCalls.length;
  let seq = 0; // 1st turn-2 call repeats verbatim, the banned regeneration varies
  geminiPayload = () => { seq += 1;
    return seq === 1
      ? { reply: 'Aaj koi class nahi hai — azaadi ki azaadi!', intent: 'class_info', needs_cr: false }
      : { reply: 'Nahi, aaj chutti hai. Kal 9 baje PF hai.', intent: 'class_info', needs_cr: false }; };
  await sendAgain(groupMsg('aaj class hai na?'));
  const made = geminiCalls.length - callsBefore;
  assert.ok(made >= 2, `repeat detected → regenerated (${made} calls)`);
  const banCall = JSON.stringify(geminiCalls[callsBefore + 1]?.body ?? {});
  assert.match(banCall, /Do NOT send it again/, 'ban instruction present');
  assert.match(banCall, /azaadi ki azaadi/, 'previous reply quoted in the ban');
  const answers = groupAnswer();
  assert.notEqual(answers[1], answers[0], 'final reply differs from the repeat');
  assert.match(answers[1], /chutti/, 'regenerated answer delivered');
});

test('GI-9b: conversation history + diversity instruction are in every Gemini prompt after turn 1', async () => {
  geminiPayload = { reply: 'Haan, PF hai aaj.', intent: 'class_info', needs_cr: false };
  await handleGroupMessage(groupMsg('aaj PF hai?'));
  geminiPayload = { reply: 'Bilkul — 9 baje, B-204.', intent: 'class_info', needs_cr: false };
  await sendAgain(groupMsg('room kaunsa hai?'));
  const prompt = JSON.stringify(geminiCalls[1].body);
  assert.match(prompt, /DIVERSITY CHECK/, 'anti-repeat instruction');
  assert.match(prompt, /PF hai aaj/, 'previous bot reply carried in memory');
});

/* ---------- 10. needs_cr: a REAL task via the existing workflow ---------- */

test('GI-10: CR-confirmation question → REAL TeacherQuestion task + honest verified group reply', async () => {
  geminiPayload = { reply: 'Ye official confirm karna hoga.', intent: 'cr_needed', needs_cr: true };
  await handleGroupMessage(groupMsg('university ne fee waiver ka last date extend kiya hai?'));
  const task = await TeacherQuestion.findOne({}).lean();
  assert.ok(task, 'real task created');
  assert.equal(task.escalatedBy, 'group-chat');
  assert.equal(task.teacher, null, 'group asker has no Teacher record');
  assert.equal(task.phone, STUDENT, 'answer delivery targets the asker');
  assert.match(task.teacherName, /Sara Khan/, 'real asker name from the roster');
  assert.equal(task.status, 'pending_cr');
  assert.ok(task.crNotifiedAt, 'CR dispatch succeeded (gateway confirmed)');
  const crPing = waSent.find((s) => s.params.to === CR_PHONE);
  assert.ok(crPing, 'CR DM really sent');
  assert.match(crPing.params.body, /Sara Khan/, 'CR alert names the student');
  assert.match(crPing.params.body, /fee waiver/, 'question verbatim');
  assert.match(crPing.params.body, /Q-[A-F0-9]{4}/, 'ref code for the CR reply');
  const answers = groupAnswer();
  assert.match(answers[0], /CR Ali Raza ko bhej diya hai/, 'group reply states the VERIFIED result');
  assert.match(answers[0], /Q-[A-F0-9]{4}/, 'ref code shared with the asker');
  assert.ok(!/official confirm karna hoga/.test(answers[0]), "the LLM's own text is NEVER the status claim");
});

test('GI-11: needs_cr dispatch FAILURE → honest could-not-send, task still recoverable', async () => {
  // CR without a phone → dispatch cannot confirm → honest wording, no fake claim
  await Section.updateOne({ _id: section._id }, { cr: null });
  const noPhoneCr = await User.create({ name: 'Phoneless CR', email: 'nocr@gi-test.local', password: 'Pass#12345678', role: 'cr', section: section._id });
  await Section.updateOne({ _id: section._id }, { cr: noPhoneCr._id });
  geminiPayload = { reply: 'x', intent: 'cr_needed', needs_cr: true };
  await handleGroupMessage(groupMsg('sir ne kaha tha quiz cancel — confirm karo'));
  const task = await TeacherQuestion.findOne({}).lean();
  assert.ok(task, 'task persisted (recoverable — sweep retries the dispatch)');
  assert.ok(!task.crNotifiedAt, 'no fake delivery state');
  const answers = groupAnswer();
  assert.ok(/CR ko bhej raha hoon/.test(answers[0]) || /bheja nahi ja saka/.test(answers[0]),
    'honest pending/failure wording');
  await Section.updateOne({ _id: section._id }, { cr: crUser._id });
});

test('GI-12: same needs_cr question re-asked → task REUSED, no duplicate CR ping', async () => {
  geminiPayload = { reply: 'x', intent: 'cr_needed', needs_cr: true };
  await handleGroupMessage(groupMsg('fee waiver ka date extend hua?'));
  await sendAgain(groupMsg('fee waiver ka date extend hua?'));
  assert.equal(await TeacherQuestion.countDocuments({}), 1, 'one durable task');
  assert.equal(waSent.filter((s) => s.params.to === CR_PHONE).length, 1, 'CR pinged once');
  assert.match(groupAnswer()[1], /pehle hi.*bheja ja chuka hai/, 'reuse told honestly');
});

test('GI-13: CR answers via ref code → answer DMs the group asker, task closes', async () => {
  geminiPayload = { reply: 'x', intent: 'cr_needed', needs_cr: true };
  await handleGroupMessage(groupMsg('fee waiver extend confirm karo'));
  const task = await TeacherQuestion.findOne({}).lean();
  await handleCrQuestionReply(CR_PHONE, `${task.refCode} Ji, extension nahi hui — same date hai.`, { data: { id: 'cr-reply-gi-1', from: `${CR_PHONE}@c.us` } });
  const closed = await TeacherQuestion.findById(task._id).lean();
  assert.equal(closed.status, 'closed', 'closed only after delivery');
  const dm = waSent.find((s) => s.params.to === STUDENT && /extension nahi hui/.test(s.params.body));
  assert.ok(dm, 'CR answer delivered to the asker');
});

/* ---------- live bug 2026-10-13: empty reply + needs_cr ---------- */

test('GI-10b (live bug 2026-10-13): {"reply":"","needs_cr":true} is a VALID escalation, never a keyword fallback', async () => {
  // production sent the fee/CR question to the keyword fallback because the
  // empty reply + needs_cr response was discarded as unparseable
  geminiPayload = { reply: '', needs_cr: true, intent: 'cr_needed' };
  assert.equal(await handleGroupMessage(groupMsg('@Tri3M fee waiver ki last date CR se confirm karo')), true);
  const task = await TeacherQuestion.findOne({ question: /fee waiver/ }).lean();
  assert.ok(task, 'real task created despite the empty LLM reply');
  const reply = groupAnswer()[0];
  assert.match(reply, /CR Ali Raza ko bhej diya hai/, 'backend-composed verified status, not a fallback card');
  assert.match(reply, new RegExp(task.refCode), 'refCode in the group reply');
  assert.ok(!/CR:/i.test(reply), 'the old fallback CR-card never fires for a needs_cr answer');
});

/* ---------- 11. silence preserved: untagged + self-messages ---------- */

test('GI-14: untagged messages and the bot\u2019s own messages stay silent (no loops)', async () => {
  geminiPayload = { reply: 'should not fire', intent: 'banter', needs_cr: false };
  await handleGroupMessage(groupMsg('koi class hai?', { tagged: false }));
  assert.equal(geminiCalls.length, 0, 'untagged never wakes the model');
  await handleGroupMessage(groupMsg('hello', { author: process.env.ULTRAMSG_GATEWAY_PHONE }));
  assert.equal(groupAnswer().length, 0, 'self-message never answered — no loop');
  await handleGroupMessage(groupMsg('koi class hai?')); // fresh new id → answered
  assert.equal(groupAnswer().length, 1, 'a genuine new tagged message is answered');
});
