/**
 * OWNER SPEC 2026-10-13 #3 — "Persistent Conversation Memory, Context
 * Awareness & Natural AI Personality". End-to-end SEQUENCE tests through the
 * REAL handleGroupMessage pipeline (Gemini mocked at the fetch boundary,
 * data + DB real). Not one-message unit tests: multi-turn conversations.
 *
 * A  greeting -> joke ("assignment ne zinda rakha?") -> joke continuation
 *    ("nahi, assignment ne maar diya") — history reaches the model, the
 *    reply continues the conversation, online AND offline.
 * B  reference resolution ("dusra wala") from recent offered titles.
 * C  casual message never gets the academic fallback.
 * D  academic answer stays consistent with verified portal data (the data
 *    JSON reaches the model).
 * E  genuinely unknown academic -> in-group CR mention, no private task.
 * F  "restart" (fresh module import + cleared in-memory guards) — history
 *    is read back from the DATABASE, conversation continues.
 * G  duplicate webhook + simultaneous messages -> one reply each, no
 *    mixed/crossed history.
 * H  consecutive greetings offline -> varied, never the same canned line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const replset = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = replset.getUri('group_memory_test');
process.env.JWT_SECRET = 'test-only-jwt-secret-gm';
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
const chatbot = await import('../backend/services/chatbotService.js');
const { handleGroupMessage, classifyGroupIntent } = chatbot;

const { Section, Subject, Note, Assignment, Timetable, ChatbotLog, ChatbotSetting, Department, AcademicSession, User, TeacherQuestion } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const GROUP_ID = '1203630999@g.us';
const GROUP2_ID = '1203630800@g.us'; // unrelated group — histories must never mix
const STUDENT = '923007770001';
const CR_PHONE = '923005555000';
const waSent = [];
const geminiCalls = [];
let geminiPayload = null; // canned {reply,intent,needs_cr,send_note_titles} or () => object
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
    geminiCalls.push({ body: JSON.parse(opts.body) });
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
const nextMsgId = () => `gm-${++msgCounter}`;
const groupMsg = (body, { author = STUDENT, id = null, groupId = GROUP_ID, tagged = true } = {}) => {
  const text = tagged ? `@${process.env.ULTRAMSG_GATEWAY_PHONE} ${body}`.trim() : body;
  return { event_type: 'message_received', instanceId: 'instance123',
    data: { id: id ?? nextMsgId(), type: 'chat', fromMe: false, chatId: groupId, from: groupId,
      author: `${author}@c.us`, body: text, time: nowSec() } };
};
const groupAnswers = () => waSent.filter((s) => s.kind === 'chat').map((s) => s.params);
const lastAnswer = () => groupAnswers().at(-1);
// cooldown-free sequential send (mirrors the CI suite's sendAgain)
const sendSeq = async (payload) => { chatbot.__resetGuards(); return handleGroupMessage(payload); };
/** The full text (prompt) of the LAST Gemini request. */
const lastPrompt = () => {
  const c = geminiCalls.at(-1);
  return c?.body?.contents?.map?.((t) => t.parts?.[0]?.text ?? '').join('\n') ?? '';
};
const chatSends = () => waSent.filter((s) => s.kind === 'chat');

let section, subject, ict;
test.before(async () => {
  await Section.deleteMany({}); await Subject.deleteMany({}); await User.deleteMany({ email: /@gm-test\.local$/ });
  const dept = await Department.create({ name: 'AI Department', code: 'AID' });
  const session = await AcademicSession.create({ name: '2024-2028' });
  section = await Section.create({ name: '3M', semester: 2, department: dept._id, session: session._id,
    whatsappGroup: { id: GROUP_ID, name: 'General 3M' } });
  subject = await Subject.create({ name: 'Programming Fundamentals', code: 'PF-101', section: section._id, status: 'active', createdBy: section._id });
  ict = await Subject.create({ name: 'Information & Comm Tech', code: 'ICT-101', section: section._id, status: 'active', createdBy: section._id });
  const crUser = await User.create({ name: 'Ali Raza', email: 'cr@gm-test.local', password: 'Pass#12345678', role: 'cr', section: section._id, phone: CR_PHONE });
  await Section.updateOne({ _id: section._id }, { cr: crUser._id });
  await User.create({ name: 'Sara Khan', email: 'sara@gm-test.local', password: 'Pass#12345678', role: 'student', section: section._id, rollNo: 'S-001', phone: STUDENT });
  await Note.create({ createdBy: section._id, author: section._id, title: 'Lecture 1 - Loops', subject: subject._id, section: section._id,
    attachments: [{ publicId: 'p1', url: 'https://res.cloudinary.com/demo/loops.pdf', mimeType: 'application/pdf', originalName: 'loops.pdf' }] });
  await Note.create({ createdBy: section._id, author: section._id, title: 'ICT Basics', subject: ict._id, section: section._id,
    attachments: [{ publicId: 'p2', url: 'https://res.cloudinary.com/demo/ict.pdf', mimeType: 'application/pdf', originalName: 'ict.pdf' }] });
  await Assignment.create({ createdBy: section._id, title: 'Lab Assignment 1', subject: subject._id, section: section._id,
    deadline: new Date(Date.now() + 3 * 86400000) });
  await Timetable.create({ section: section._id, subject: subject._id, date: new Intl.DateTimeFormat('en-CA',
    { timeZone: 'Asia/Karachi' }).format(new Date()), startTime: '09:00', endTime: '10:30', room: 'B-204', createdBy: section._id,
    teacherConfirmation: { status: 'confirmed', code: 'ABCDEF1234', phone: '923001119999', teacher: null } });
});

test.after(async () => {
  await mongoose.connection.close();
  await replset.stop();
});

/* ---------- A: the assignment-joke conversation, ONLINE ---------- */

test('GM-A: greeting -> joke -> joke continuation; history reaches the model each turn', async () => {
  geminiPayload = { reply: 'Mast hoon bhai, tumhari dua se — bolo kya scene hai?' };
  await sendSeq(groupMsg('Kya haal hain?'));
  assert.match(lastAnswer()?.body ?? '', new RegExp(`^@${STUDENT} `), 'A1 reply mentions the asker');
  assert.ok(geminiCalls.length >= 1, 'A1 went to the model');

  // A2 — academic word used as a joke; the prompt must now carry turn 1
  geminiPayload = { reply: 'Zinda rakha hai bhai — assignment ne to tumhein zinda rakha hai 😂 kitna percent complete hai abhi?' };
  await sendSeq(groupMsg('Assignment ne zinda rakha hai ya nahi?'));
  const p2 = lastPrompt();
  assert.ok(p2.includes('Kya haal hain?'), 'A2 prompt contains turn-1 student message');
  assert.ok(p2.includes('Mast hoon bhai'), 'A2 prompt contains turn-1 bot reply');
  assert.doesNotMatch(p2, /isolation|isolated/, 'history labeled');
  assert.ok(/Tri3M:/.test(p2), 'history lines are labeled with roles');

  // A3 — the continuation: the model must see turn 2 and the reply continues
  // the assignment conversation (never a fresh "kya scene ho gaya?" opener)
  geminiPayload = { reply: 'Aisa bhi hota hai bhai 😂 assignment bhi insaan hai — chhodo, jab dil uthé to notes ka ilaaj mere paas hazir hai.' };
  await sendSeq(groupMsg('Nahi, assignment ne maar diya'));
  const p3 = lastPrompt();
  assert.ok(p3.includes('Assignment ne zinda rakha hai ya nahi?'), 'A3 prompt carries turn-2 message');
  assert.ok(p3.includes('zinda rakha'), 'A3 prompt carries turn-2 reply');
  const a3 = lastAnswer()?.body ?? '';
  assert.ok(a3.includes('assignment'), 'A3 reply continues the assignment topic');
  assert.doesNotMatch(a3, /kya scene ho gaya/i, 'A3 never reopens as a new conversation');
});

/* ---------- A-offline: same conversation with Gemini DOWN ---------- */

test('GM-A-offline: the joke continuation never becomes an assignment dump or a fresh-topic card', async () => {
  geminiPayload = null;
  await sendSeq(groupMsg('kaisay ho bhai?'));
  await sendSeq(groupMsg('assignment ne zinda rakha hai ya nahi?'));
  await sendSeq(groupMsg('nahi, assignment ne maar diya'));
  const a3 = lastAnswer()?.body ?? '';
  assert.ok(a3, 'offline A3 has a reply');
  assert.doesNotMatch(a3, /Lab Assignment|assignment\s*:/i, 'offline A3 never lists assignments');
  assert.doesNotMatch(a3, /kya scene ho gaya/i, 'offline A3 never asks a fresh-topic opener');
  assert.doesNotMatch(a3, /CR se pooch|CR bhai se confirm/i, 'offline A3 is not a CR fallback');
  assert.match(a3, /assignment|ilaa?j|hazir|deadline|notes/i, 'offline A3 stays engaged with the topic');
});

/* ---------- B: reference resolution from recent offers ---------- */

test('GM-B: "dusra wala bhej do" resolves against the titles just offered', async () => {
  // offer: two notes exist; a vague ask makes the bot offer the subjects
  geminiPayload = { reply: 'Kis subject ke notes chahiye? In ke notes available hain: Lecture 1 - Loops, ICT Basics.' };
  await sendSeq(groupMsg('notes bhej do'));
  assert.ok(lastPrompt().includes('Lecture 1 - Loops'), 'B: data offers reached the model');

  geminiPayload = { reply: 'Ye raha *ICT Basics* — parh lo.', send_note_titles: ['ICT Basics'] };
  await sendSeq(groupMsg('dusra wala bhej do'));
  const p = lastPrompt();
  assert.ok(p.includes('Lecture 1 - Loops'), 'B: offered titles ride in memory');
  // the reference resolved to the OTHER offered title — the ICT one
  const fileSends = waSent.filter((s) => s.kind !== 'chat');
  assert.equal(fileSends.length, 1, 'B: exactly the referenced file delivered');
  assert.ok(/ict/i.test(JSON.stringify(fileSends[0]?.params ?? {})),
    'B: the ICT (dusra) file, not the first');
});

/* ---------- C: casual chat never hits the academic fallback ---------- */

test('GM-C: joke / teasing stays conversation, online and offline', async () => {
  geminiPayload = { reply: 'Aisi tareef ke liye main hazir hoon 😂 chal bolo, kaam poochhna tha?' };
  await sendSeq(groupMsg('tum to pagal ho bhai'));
  const online = lastAnswer()?.body ?? '';
  assert.doesNotMatch(online, /CR se pooch|CR bhai se confirm|Ye mere paas nahi/i, 'C online: no academic fallback');
  assert.equal(await TeacherQuestion.countDocuments({}), 0, 'C online: no task created');

  geminiPayload = null;
  await sendSeq(groupMsg('mazak kar rahe ho? bore ho gaya hoon'));
  const offline = lastAnswer()?.body ?? '';
  assert.doesNotMatch(offline, /CR se pooch|CR bhai se confirm/i, 'C offline: no academic fallback');
});

/* ---------- D: answerable academic stays consistent with portal data ---------- */

test('GM-D: the verified data (today\'s real slot) reaches the model; answer consistent with it', async () => {
  geminiPayload = { reply: 'Aaj 09:00 se 10:30 tak Programming Fundamentals hai, room B-204 (confirmed).' };
  await sendSeq(groupMsg('aaj ki class timing kya hai?'));
  const p = lastPrompt();
  assert.ok(p.includes('B-204'), 'D: the real room is in the model context');
  assert.ok(p.includes('Programming Fundamentals'), 'D: the real subject is in the model context');
  const ans = lastAnswer()?.body ?? '';
  assert.match(ans, /09:00/, 'D: answer consistent with the verified slot');
});

/* ---------- E: genuinely unknown academic -> group CR mention, no task ---------- */

test('GM-E: unknown academic escalates to an in-group CR mention, never a private task', async () => {
  geminiPayload = { reply: 'Is ki verified information mere paas nahi — CR bhai se confirm kar lo.', needs_cr: true };
  await sendSeq(groupMsg('library ka late fine ka exact amount kya hai?'));
  const ans = lastAnswer()?.body ?? '';
  assert.ok(ans.includes(`@${CR_PHONE}`), 'E: the CR is @mentioned in the group reply');
  assert.equal(await TeacherQuestion.countDocuments({}), 0, 'E: NO private task (strict student split)');
  assert.equal(chatSends().length, 1, 'E: no private CR DM sent');
});

/* ---------- F: persistence across a "restart" ---------- */

test('GM-F: after a module restart + cleared guards, history is still read from the DB', async () => {
  geminiPayload = { reply: 'Haan bhai, sun raha tha — bolo phir kya hua?' };
  await sendSeq(groupMsg('assignment ka masla tha mujhe'));
  assert.ok(lastPrompt().length > 0);

  // simulate a restart: FRESH module instance (all in-memory state gone),
  // same durable DB. The fresh handler must still see the previous turn.
  const fresh = await import(`../backend/services/chatbotService.js?restart=${Date.now()}`);
  fresh.__resetGuards();
  geminiPayload = { reply: 'Haan wahi masla — kitna solve ho gaya ab tak?' };
  await fresh.handleGroupMessage(groupMsg('haan wahi, phir kya?'));
  const p = lastPrompt();
  assert.ok(p.includes('assignment ka masla tha'), 'F: restart history (from DB) carries the earlier turn');
  assert.ok(p.includes('Student'), 'F: history lines present after restart');

  // durable rows: asker + msgId persisted (§6 storage contract)
  const rows = await ChatbotLog.find({ groupId: GROUP_ID }).sort({ createdAt: -1 }).limit(2).lean();
  assert.ok(rows.length >= 2, 'F: both turns persisted');
  assert.ok(rows.every((r) => r.asker === STUDENT), 'F: asker identity persisted');
  assert.ok(rows.every((r) => /^gm-/.test(String(r.msgId ?? ''))), 'F: stable inbound msg IDs persisted');
});

/* ---------- G: duplicates + concurrency ---------- */

test('GM-G: duplicate webhook redelivery answers ONCE; two simultaneous messages never mix', async () => {
  geminiPayload = { reply: 'Bilkul bhai — bolo.' };
  const payload = groupMsg('salam Tri3M', { id: 'dup-gm-1' });
  const first = await sendSeq(payload);
  const firstSends = chatSends().length;
  const second = await sendSeq({ ...payload, data: { ...payload.data } }); // exact redelivery
  assert.ok(first, 'G: first delivery handled');
  assert.equal(chatSends().length, firstSends, 'G: redelivery answered ZERO extra times');
  assert.ok(second !== undefined, 'G: redelivery returns without error');

  // two different students, same instant, same group — both answered, each
  // reply @mentions its OWN asker (histories can never cross)
  geminiPayload = { reply: 'Bolo bhai?' };
  chatbot.__resetGuards();
  const before = chatSends().length;
  const [r1, r2] = await Promise.all([
    handleGroupMessage(groupMsg('kya haal hai', { author: '923007770001', id: 'conc-1' })),
    handleGroupMessage(groupMsg('salam bhai', { author: '923007770002', id: 'conc-2' })),
  ]);
  assert.ok(r1 && r2, 'G: both concurrent messages handled');
  const concSends = chatSends().slice(before);
  const bodies = concSends.map((s) => s.params.body);
  const mentions = concSends.map((s) => s.params.body.match(/^@(\d+)/)?.[1]);
  assert.equal(bodies.length, 2, 'G: exactly one reply per concurrent message');
  assert.ok(mentions.includes('923007770001') && mentions.includes('923007770002'),
    'G: each reply @mentions its own asker — no crossed history');
});

/* ---------- H: variety, offline ---------- */

test('GM-H: repeated greetings/jokes never ship the same canned line twice in a row', async () => {
  geminiPayload = null; // fully offline — the canned nets are the variation floor
  let seen = [];
  for (const q of ['kaisay ho?', 'kya haal hai bhai?', 'kaisay ho aaj?', 'assalam o alaikum']) {
    await sendSeq(groupMsg(q));
    const ans = lastAnswer()?.body ?? '';
    assert.ok(ans, `H: ${q} answered`);
    assert.doesNotMatch(ans, /Ye mere paas nahi|CR se poochein/i, 'H: never the dry card');
    assert.ok(!seen.includes(ans), `H: "${q}" never repeats the immediately previous canned line`);
    seen = [ans]; // only the previous reply is guaranteed fresh (adjacent-dup rule)
  }
});

/* ---------- history scoping: another group NEVER leaks in ---------- */

test('GM-scope: a different group\'s history never mixes into this one', async () => {
  geminiPayload = { reply: 'Bolo bhai.' };
  await sendSeq(groupMsg('secret topic alpha', { groupId: GROUP2_ID }));
  // GROUP2 is not this section's linked group — the bot stays silent
  assert.equal(chatSends().length, 0, 'scope: unlinked group stays silent');

  // and a direct row from another group is never picked up as history
  await ChatbotLog.create({ section: section._id, groupId: '999-unlinked@g.us',
    question: 'unrelated old question', reply: 'unrelated old answer', source: 'gemini' });
  geminiPayload = { reply: 'Bolo.' };
  await sendSeq(groupMsg('kuch poochhna tha'));
  const p = lastPrompt();
  assert.doesNotMatch(p, /unrelated old question/, 'scope: foreign-group history never mixes in');
});
