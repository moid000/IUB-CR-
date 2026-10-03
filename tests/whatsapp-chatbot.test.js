/**
 * STEP — Tri3M WhatsApp GROUP CHATBOT (owner-approved 2026-10-03).
 * In-memory replica set; UltraMsg + Gemini are simulated by a fetch
 * wrapper that intercepts only their URLs.
 *
 * Safety contract under test:
 * - Bot OFF → handleGroupMessage is a no-op (false) and the teacher DM
 *   flow behaves exactly as before.
 * - Group messages are always CONSUMED (never reach the teacher flow).
 * - Only linked groups answered; old/replayed + self messages ignored.
 * - Casual chat never wakes the bot; budget guards hold.
 * - No LLM key / Gemini failure → deterministic keyword fallback.
 * - Note-file delivery sends real media messages, capped at 3.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

// keep the handle so the suite process can actually EXIT when tests finish
const replset = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = replset.getUri('chatbot_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
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
const { env } = await import('../backend/config/env.js');
const chatbot = await import('../backend/services/chatbotService.js');
const {
  handleGroupMessage, shouldTrigger, stripMentions, parseGeminiJson,
  buildFallbackReply, pickNotesForDelivery, isGroupMessage, groupIdOf, contextData, subjectAsked,
} = chatbot;

const { Section, Subject, Note, Assignment, Timetable, ChatbotLog, ChatbotSetting, Department, AcademicSession, User, Teacher, Announcement } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

const GROUP_ID = '1203630999@g.us';
const STUDENT = '923007770001';
const waSent = [];  // UltraMsg sends: { kind, params }
const geminiCalls = []; // Gemini requests: { body }
let geminiResponse = null; // canned Gemini JSON per test

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('ultramsg.test.local')) {
    if (/\/messages\/(chat|image|document|audio|video)/.test(u)) {
      const params = Object.fromEntries(new URLSearchParams(opts.body));
      waSent.push({ kind: u.match(/\/messages\/(\w+)$/)[1], params });
      return new Response(JSON.stringify({ sent: true }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    geminiCalls.push({ url: u, body: JSON.parse(opts.body) });
    const resp = typeof geminiResponse === 'function' ? geminiResponse(u) : geminiResponse;
    if (!resp) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(resp), { status: 200 });
  }
  return realFetch(url, opts);
};

test.afterEach(async () => {
  waSent.length = 0;
  geminiCalls.length = 0;
  geminiResponse = null;
  chatbot.__resetGuards(); // fresh cooldown/hour/day budget per test
  await ChatbotSetting.deleteMany({}); // panel switch resets to env defaults
});

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const nowSec = () => Math.floor(Date.now() / 1000);

/** UltraMsg-shaped inbound group message payload. */
function groupMsg(body, { author = STUDENT, time = null, chatId = GROUP_ID } = {}) {
  return {
    event_type: 'message_received',
    instanceId: 'instance123',
    data: {
      id: 'TESTID123', type: 'chat', fromMe: false,
      chatId, from: chatId, author: `${author}@c.us`,
      body, time: time ?? nowSec(),
    },
  };
}

/* ---------------------------- fixtures ---------------------------- */
let section, subject, noteWithFile, noteNoFile, slot, assignment;

test.before(async () => {
  await Section.deleteMany({});
  await Subject.deleteMany({});
  const dept = await Department.create({ name: 'AI Department', code: 'AID' });
  const session = await AcademicSession.create({ name: '2024-2028' });
  section = await Section.create({
    name: '3M', semester: 2, department: dept._id, session: session._id,
    whatsappGroup: { id: GROUP_ID, name: 'General 3M' },
  });
  subject = await Subject.create({ name: 'ICT', code: 'ICT-101', section: section._id, status: 'active', createdBy: section._id });
  noteWithFile = await Note.create({ createdBy: section._id, author: section._id,
    title: 'Lecture 1 - Introduction', subject: subject._id, section: section._id,
    attachments: [{ publicId: 'p1', url: 'https://res.cloudinary.com/demo/n1.pdf', mimeType: 'application/pdf', originalName: 'intro.pdf' }],
  });
  noteNoFile = await Note.create({ createdBy: section._id, author: section._id, title: 'Lecture 2 - Logic Gates', subject: subject._id, section: section._id });
  slot = await Timetable.create({
    section: section._id, subject: subject._id, date: today,
    startTime: '09:00', endTime: '10:30', room: 'B-204',
    createdBy: section._id,
    teacherConfirmation: { status: 'confirmed', code: 'ABCDEF1234', phone: '923001119999', teacher: null },
  });
  assignment = await Assignment.create({ createdBy: section._id,
    title: 'Assignment 1', subject: subject._id, section: section._id,
    deadline: new Date(Date.now() + 3 * 86400000),
  });

  // roster context fixtures (chatbot owner request 2026-10-03)
  await User.deleteMany({ email: /@chatbot-test\.local$/ });
  const crUser = await User.create({ name: 'Ali Raza', email: 'cr@chatbot-test.local', password: 'Pass#12345678', role: 'cr', section: section._id });
  await User.create({ name: 'Sara Khan', email: 'sara@chatbot-test.local', password: 'Pass#12345678', role: 'student', section: section._id, rollNo: 'S-001' });
  await User.create({ name: 'Bilal Ahmed', email: 'bilal@chatbot-test.local', password: 'Pass#12345678', role: 'student', section: section._id, rollNo: 'S-002' });
  await Section.updateOne({ _id: section._id }, { cr: crUser._id });
  await Teacher.deleteMany({ section: section._id });
  await Teacher.create({ name: 'Dr. Usman Tariq', subject: subject._id, section: section._id, designation: 'Professor', whatsapp: '923009999999', email: 't@chatbot-test.local', createdBy: crUser._id });
  await Announcement.create({ title: 'Quiz next week', content: 'AI ki quiz agle hafte hogi.', section: section._id, author: crUser._id });
});

test.after(async () => {
  server.close();
  await mongoose.connection.close();
  await replset.stop(); // without this the mongod child keeps the node process alive forever
});

/* ------------------------ pure helper tests ------------------------ */

test('shouldTrigger: questions/keywords wake the bot, casual chat does not', () => {
  assert.equal(shouldTrigger('aj timetable kya hai'), true);
  assert.equal(shouldTrigger('@923019670950 notes do'), true);
  assert.equal(shouldTrigger('class kitni baje?'), true);
  assert.equal(shouldTrigger('ICT ke notes bhej do'), true);
  assert.equal(shouldTrigger('aj sir ny kia perhaya'), true);
  assert.equal(shouldTrigger('assignment deadline?'), true);
  assert.equal(shouldTrigger('section me kaun kaun students hain'), true);
  assert.equal(shouldTrigger('cr kaun hai hamara'), true);
  assert.equal(shouldTrigger('hamari section konsi hai'), true);
  assert.equal(shouldTrigger('kya haal hai doston'), false); // casual — no keyword/?
  assert.equal(shouldTrigger('ok'), false);
  assert.equal(shouldTrigger('hi bot'), true); // direct address
  assert.equal(shouldTrigger(''), false);
  assert.equal(shouldTrigger('x'.repeat(500)), false);
});

test('stripMentions removes mention tokens', () => {
  assert.equal(stripMentions('@923001234567 aj ki class timing kya hai'), 'aj ki class timing kya hai');
  assert.equal(stripMentions('@Tri3M notes?'), 'notes?');
});

test('parseGeminiJson handles clean, fenced and dirty output', () => {
  assert.deepEqual(parseGeminiJson('{"reply":"hi","send_note_titles":["A"]}'), { reply: 'hi', send_note_titles: ['A'] });
  assert.deepEqual(parseGeminiJson('```json\n{"reply":"hi"}\n```'), { reply: 'hi', send_note_titles: [] });
  const parsed = parseGeminiJson('Sure! {"reply":"hi"} ok');
  assert.equal(parsed?.reply, 'hi');
  assert.equal(parseGeminiJson('no json at all'), null);
  assert.equal(parseGeminiJson('{"reply":""}'), null);
});

test('isGroupMessage / groupIdOf shape detection', () => {
  assert.equal(isGroupMessage(groupMsg('timetable?')), true);
  assert.equal(isGroupMessage({
    event_type: 'message_received', data: { fromMe: false, type: 'chat', from: '923001119999', body: 'YES' },
  }), false);
  assert.equal(groupIdOf({ data: { chatId: GROUP_ID } }), GROUP_ID);
});

/* ------------------------ behavioral tests ------------------------ */

test('bot OFF: group message is NOT consumed — teacher flow unchanged', async () => {
  const wasEnabled = env.chatbot.enabled;
  env.chatbot.enabled = false;
  try {
    assert.equal(await handleGroupMessage(groupMsg('aj timetable?')), false);
    assert.equal(waSent.length, 0);
    assert.equal(geminiCalls.length, 0);
  } finally {
    env.chatbot.enabled = wasEnabled;
  }
});

test('linked group + question → Gemini answer sent to the group, audit logged', async () => {
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{"reply":"*Aaj ki classes*\\n• 9:00 AM – 10:30 AM — *ICT* | B-204 (Teacher confirmed ✅)"}' }] } }] };
  assert.equal(await handleGroupMessage(groupMsg('aj ki class timing kya hai?')), true);
  assert.equal(geminiCalls.length, 1);
  assert.ok(String(geminiCalls[0].url).includes('gemini-3.8-flash'));
  assert.ok(String(geminiCalls[0].body.contents[0].parts[0].text).includes('B-204'));
  const sentData = String(geminiCalls[0].body.contents[0].parts[0].text);
  assert.ok(sentData.includes('Ali Raza'), 'CR name reaches the LLM');
  assert.ok(sentData.includes('Sara Khan'), 'student roster reaches the LLM');
  assert.ok(sentData.includes('Dr. Usman Tariq'), 'teacher reaches the LLM');
  assert.ok(!sentData.includes('923009999999'), 'teacher WhatsApp number never reaches the LLM');
  assert.ok(!sentData.includes('iubcr.vercel.app'), 'no portal link in bot context');
  assert.equal(waSent.length, 1);
  assert.equal(waSent[0].kind, 'chat');
  assert.equal(waSent[0].params.to, GROUP_ID);
  assert.match(waSent[0].params.body, /ICT/);
  const log = await ChatbotLog.findOne({ groupId: GROUP_ID }).sort({ createdAt: -1 });
  assert.ok(log);
  assert.equal(log.source, 'gemini');
  assert.match(log.question, /class timing/);
});

test('Gemini down everywhere → keyword fallback still answers (no crash, no hallucination)', async () => {
  geminiResponse = null; // 500 from every model in the chain
  assert.equal(await handleGroupMessage(groupMsg('aj ka timetable batao?')), true);
  assert.ok(geminiCalls.length >= 1, 'at least one attempt made');
  assert.ok(geminiCalls.length <= 6, 'chain stays inside the retry budget');
  assert.equal(waSent.length, 1);
  assert.match(waSent[0].params.body, /9:00 AM/);
  const log = await ChatbotLog.findOne({ groupId: GROUP_ID }).sort({ createdAt: -1 });
  assert.equal(log.source, 'fallback');
});

test('primary model overloaded (503) → backup model answers, student still gets a real reply', async () => {
  // primary 3.8 is down; the first backup (gemini-flash-latest) answers
  geminiResponse = (u) => u.includes('gemini-3.8-flash')
    ? null
    : { candidates: [{ content: { parts: [{ text: '{\"reply\":\"Aaj ICT ki class 9:00 AM hai.\"}' }] } }] };
  assert.equal(await handleGroupMessage(groupMsg('aj ki class timing?')), true);
  assert.ok(geminiCalls.some((c) => String(c.url).includes('gemini-3.8-flash')), 'primary tried first');
  assert.ok(geminiCalls.some((c) => String(c.url).includes('gemini-flash-latest')), 'backup model reached');
  assert.ok(waSent.some((s) => s.kind === 'chat' && /9:00 AM/.test(s.params.body)));
  const log = await ChatbotLog.findOne({ groupId: GROUP_ID }).sort({ createdAt: -1 });
  assert.equal(log.source, 'gemini');
});

test('notes request with send_note_titles → real files delivered (max 3, never fabricated)', async () => {
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{"reply":"Yeh raha Lecture 1 ka note 📎","send_note_titles":["Lecture 1 - Introduction","Lecture 2 - Logic Gates","Made Up Note","Lecture 1 - Introduction"]}' }] } }] };
  await handleGroupMessage(groupMsg('ICT ke notes bhej do?'));
  // reply text + up to 3 matched files (made-up title ignored, dup collapsed by cap)
  const kinds = waSent.map((s) => s.kind);
  assert.ok(kinds.includes('chat'));
  assert.equal(kinds.filter((k) => k === 'document').length, 1); // only the file-backed note matches
  const doc = waSent.find((s) => s.kind === 'document');
  assert.equal(doc.params.document, 'https://res.cloudinary.com/demo/n1.pdf');
  assert.match(doc.params.filename, /intro\.pdf/);
});

test('pickNotesForDelivery caps at 3 files and matches titles tolerantly', () => {
  const notes = [
    { title: 'A Note', attachments: [{ url: 'u1', mimeType: 'application/pdf' }, { url: 'u2', mimeType: 'application/pdf' }] },
    { title: 'B Note', attachments: [{ url: 'u3', mimeType: 'application/pdf' }, { url: 'u4', mimeType: 'application/pdf' }] },
  ];
  const picked = pickNotesForDelivery(['a note', 'b note'], notes);
  assert.equal(picked.length, 3); // MAX_FILES_PER_REPLY
  assert.equal(picked[0].note.title, 'A Note');
});

test('unlinked group → consumed but silent (privacy)', async () => {
  const other = groupMsg('timetable?', { chatId: '1203630777@g.us' });
  assert.equal(await handleGroupMessage(other), true);
  assert.equal(waSent.length, 0);
  assert.equal(geminiCalls.length, 0);
});

test('old/replayed message and self message are ignored', async () => {
  const stale = groupMsg('timetable?', { time: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(await handleGroupMessage(stale), true);
  const self = groupMsg('timetable?', { author: '923001234567' }); // gateway's own number
  assert.equal(await handleGroupMessage(self), true);
  assert.equal(waSent.length, 0);
  assert.equal(geminiCalls.length, 0);
});

test('casual chat is consumed silently — no LLM spend', async () => {
  assert.equal(await handleGroupMessage(groupMsg('kya haal hai doston')), true);
  assert.equal(geminiCalls.length, 0);
  assert.equal(waSent.length, 0);
});

test('per-group cooldown: an immediate second question is dropped', async () => {
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{"reply":"ok"}' }] } }] };
  assert.equal(await handleGroupMessage(groupMsg('kal ki class?')), true);
  const sentAfterFirst = waSent.length;
  assert.ok(sentAfterFirst >= 1);
  geminiCalls.length = 0;
  assert.equal(await handleGroupMessage(groupMsg('aur aj ki?')), true);
  assert.equal(geminiCalls.length, 0); // cooled down
  assert.equal(waSent.length, sentAfterFirst);
});

const FALLBACK_DATA = {
  section: '3M', department: 'AI Department', semester: 2, session: '2024-2028',
  cr: 'Ali Raza', gr: 'Not set yet',
  timetable: [
    { date: today, day: 'today', time: '9:00 AM – 10:30 AM', subject: 'ICT', room: 'B-204', status: 'Teacher confirmed ✅' },
  ],
  subjects: [
    { name: 'ICT', code: 'ICT-101' },
    { name: 'Programming', code: 'CS-102' },
    { name: 'Artificial Intelligence', code: 'AI-101' },
  ],
  noteFileIndex: [{ title: 'Lecture 1 - Introduction', subject: 'ICT', hasFiles: true }],
  assignments: [{ title: 'Assignment 1', subject: 'ICT', deadline: 'soon', past: false }],
  students: [
    { name: 'Sara Khan', rollNo: 'S-001' },
    { name: 'Bilal Ahmed', rollNo: 'S-002' },
  ],
  teachers: [
    { name: 'Dr. Usman Tariq', subject: 'ICT', designation: 'Professor' },
    { name: 'Dr. Ayesha Siddiqui', subject: 'Programming', designation: 'Assistant Professor' },
    { name: 'Dr. Waqar Malik', subject: 'Artificial Intelligence', designation: 'Professor' },
  ],
  announcements: [{ title: 'Quiz next week', date: 'today' }],
};

test('fallback builder: classes, notes, deadlines', async () => {
  assert.match(buildFallbackReply('aj ki class?', FALLBACK_DATA), /9:00 AM/);
  assert.match(buildFallbackReply('ICT ke notes', FALLBACK_DATA), /Lecture 1/);
  assert.match(buildFallbackReply('assignments?', FALLBACK_DATA), /Assignment 1/);
});

test('owner rule: fallback replies NEVER send portal links or hand emojis', async () => {
  const probes = [
    'aj ki class?', 'ICT ke notes', 'assignments?', 'kal ki class?',
    'konsi class hai aj ki', 'section me kaun kaun students hain', 'cr kaun hai',
    'sara ka phone number kya hai?', 'random greeting text',
  ];
  for (const q of probes) {
    const r = buildFallbackReply(q, FALLBACK_DATA);
    assert.ok(!/portal|website|iubcr|http/i.test(r), `portal/link leaked for: ${q}`);
    assert.ok(!/[🙏🙌🤝]/u.test(r), `hand emoji leaked for: ${q}`);
  }
});

test('fallback builder: no class today → plain "koi class nahi" + upcoming, no portal pointer', async () => {
  const data = { ...FALLBACK_DATA, timetable: [
    { date: '2099-01-01', day: 'Fri 1 Jan', time: '9:00 AM – 10:30 AM', subject: 'ICT', room: 'B-204', status: 'Teacher confirmed ✅' },
  ] };
  const r = buildFallbackReply('aj ki class?', data);
  assert.match(r, /koi class nahi/i);
  assert.ok(!/portal/i.test(r));
  assert.match(r, /9:00 AM/); // upcoming classes listed instead of a deflection
});

test('fallback builder: section / CR / student roster answers (names + rollNo only)', async () => {
  const roster = buildFallbackReply('hamari section konsi hai aur cr kaun hai?', FALLBACK_DATA);
  assert.match(roster, /3M/);
  assert.match(roster, /AI Department/);
  assert.match(roster, /Ali Raza/);
  assert.ok(!/Not set yet/.test(roster)); // GR unset → line omitted, not exposed

  const list = buildFallbackReply('class ke students kaun kaun hain?', FALLBACK_DATA);
  assert.match(list, /Sara Khan \(S-001\)/);
  assert.match(list, /Bilal Ahmed \(S-002\)/);
  assert.ok(!/@|mail|9230|Pass/i.test(list)); // no contact/personal data ever

  const teachers = buildFallbackReply('teacher kaun hai ICT ka?', FALLBACK_DATA);
  assert.match(teachers, /Dr\. Usman Tariq/);
  assert.ok(!/923009999999/.test(teachers)); // teacher's WhatsApp number never shared
});

test('owner rule: fallback precision — question-type answers, personal-info refusal, CR guidance', async () => {
  // "konsi class" is a TIMETABLE question, not a roster dump (owner's bug report)
  const cls = buildFallbackReply('konsi class hai aj ki?', FALLBACK_DATA);
  assert.match(cls, /9:00 AM/);
  assert.ok(!/Ali Raza|Sara Khan/.test(cls), 'roster must not leak into class questions');

  // personal info of any person → polite refusal, never the data
  const refusal = buildFallbackReply('sara ka phone number kya hai?', FALLBACK_DATA);
  assert.match(refusal, /personal information/i);
  assert.match(refusal, /CR se poochein/i);
  assert.ok(!/S-001|S-002/.test(refusal));

  // "kitny students" → count, not the whole roster
  const count = buildFallbackReply('class me kitny students hain?', FALLBACK_DATA);
  assert.match(count, /2 students add hain/);
  assert.ok(!/Sara Khan/.test(count), 'count question must not dump all names');

  // unknown question → CR guidance (owner rule: never "check the portal")
  const unknown = buildFallbackReply('festival me kya khana banana chahiye?', FALLBACK_DATA);
  assert.match(unknown, /CR se poochein/i);
  assert.ok(!/portal|http/i.test(unknown));
});

test('owner rule: teacher questions answer ONE teacher, not every teacher/subject (professional precision)', async () => {
  // specific subject by abbreviation "AI"
  const ai = buildFallbackReply('AI ka teacher kon hai?', FALLBACK_DATA);
  assert.match(ai, /Dr\. Waqar Malik/);
  assert.ok(!/Dr\. Usman Tariq/.test(ai) && !/Dr\. Ayesha Siddiqui/.test(ai), 'other teachers must not leak');

  // specific subject by full name
  const prog = buildFallbackReply('Programming ka ustaad kaun hai?', FALLBACK_DATA);
  assert.match(prog, /Dr\. Ayesha Siddiqui/);
  assert.ok(!/Dr\. Usman Tariq/.test(prog));

  // no subject named, several teachers → asks which subject (no dump)
  const vague = buildFallbackReply('teacher kaun hai?', FALLBACK_DATA);
  assert.match(vague, /3 teachers hain/);
  assert.ok(!/Dr\. Usman Tariq/.test(vague), 'must not dump all teachers');

  // explicit "sab" → full list is fine
  const all = buildFallbackReply('sab teachers kaun kaun hain?', FALLBACK_DATA);
  assert.match(all, /Dr\. Usman Tariq/);
  assert.match(all, /Dr\. Waqar Malik/);
});

test('subjectAsked pins the subject by name, code or abbreviation', async () => {
  const subjects = [
    { name: 'Artificial Intelligence', code: 'AI-101' },
    { name: 'ICT', code: 'ICT-101' },
  ];
  assert.equal(subjectAsked('AI ka teacher kon hai', subjects)?.name, 'Artificial Intelligence');
  assert.equal(subjectAsked('artificial intelligence ki class timing', subjects)?.name, 'Artificial Intelligence');
  assert.equal(subjectAsked('ict-101 ke notes', subjects)?.name, 'ICT');
  assert.equal(subjectAsked('kya haal hai', subjects), null);
});

test('contextData: CR/GR/students/teachers/announcements included, NO portal key, NO contact fields', async () => {
  const ctx = {
    section: { name: '3M', semester: 2, department: { name: 'AI Department' }, session: { name: '2024-2028' }, cr: { name: 'Ali Raza' }, gr: null },
    subjects: [], slots: [], notes: [], assignments: [],
    students: [{ name: 'Sara Khan', rollNo: 'S-001' }],
    teachers: [{ name: 'Dr. Usman Tariq', subject: { name: 'ICT' }, designation: 'Professor' }],
    announcements: [{ title: 'Quiz next week', createdAt: new Date().toISOString() }],
  };
  const data = contextData(ctx);
  assert.equal(data.cr, 'Ali Raza');
  assert.equal(data.gr, 'Not set yet');
  assert.deepEqual(data.students, [{ name: 'Sara Khan', rollNo: 'S-001' }]);
  assert.equal(data.teachers[0].name, 'Dr. Usman Tariq');
  assert.equal(data.announcements[0].title, 'Quiz next week');
  const json = JSON.stringify(data);
  assert.ok(!('portal' in data), 'portal key removed (owner rule: no links)');
  assert.ok(!/phone|email|whatsapp/i.test(json), 'no contact fields in bot data');
});

/* ------------------- route-level integration ------------------- */

test('webhook route: group message → chatbot answers; DM still goes to teacher flow', async () => {
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{"reply":"Aaj 9:00 AM — ICT"}' }] } }] };
  const res = await fetch(`${BASE}/api/whatsapp/teacher-reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': 'whsec-test' },
    body: JSON.stringify(groupMsg('portal pe kya naya hai?')),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json, { success: true, data: { updated: false } }); // teacher flow untouched
  assert.ok(waSent.some((s) => s.kind === 'chat' && s.params.to === GROUP_ID));

  // DM (not a group) with a non-YES body: teacher flow runs, bot silent.
  waSent.length = 0; geminiCalls.length = 0;
  const dm = await fetch(`${BASE}/api/whatsapp/teacher-reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': 'whsec-test' },
    body: JSON.stringify({
      event_type: 'message_received', instanceId: 'instance123',
      data: { id: 'X', type: 'chat', fromMe: false, from: '923001119999', body: 'kya haal' },
    }),
  });
  assert.equal(dm.status, 200);
  assert.equal(geminiCalls.length, 0); // DMs never reach the chatbot
});


/* -------- Administration panel ON/OFF switch (owner request) -------- */
let adminCookie = '';
{
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'AdminPass123!456' }),
  });
  assert.equal(res.status, 200, 'admin login for switch tests');
  adminCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(adminCookie, 'admin cookie captured');
}

test('chatbot switch: admin route requires an admin session', async () => {
  const res = await fetch(`${BASE}/api/admin/chatbot`);
  assert.equal(res.status, 401);
});

test('chatbot switch: defaults mirror env (enabled + key from env) and never leak the key', async () => {
  const res = await fetch(`${BASE}/api/admin/chatbot`, { headers: { cookie: adminCookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.enabled, true); // env WHATSAPP_CHATBOT_ENABLED=true in this suite
  assert.equal(json.data.apiKeyConfigured, true);
  assert.equal(json.data.apiKeySource, 'env');
  assert.ok(!JSON.stringify(json).includes('test-gemini-key'), 'GET never returns the key value');
});

test('chatbot switch: panel OFF wins over env ON — bot goes fully silent', async () => {
  const put = await fetch(`${BASE}/api/admin/chatbot`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(put.status, 200);
  const json = await put.json();
  assert.equal(json.data.enabled, false);

  const consumed = await handleGroupMessage(groupMsg('aj timetable kya hai?'));
  assert.equal(consumed, false); // switch OFF → the whole branch is skipped
  assert.equal(geminiCalls.length, 0);
  assert.equal(waSent.length, 0);
});

test('chatbot switch: panel ON keeps Gemini using the server env key', async () => {
  const put = await fetch(`${BASE}/api/admin/chatbot`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(put.status, 200);
  const putJson = await put.json();
  assert.equal(putJson.data.enabled, true);
  assert.equal(putJson.data.apiKeySource, 'env'); // key only ever comes from the env

  geminiResponse = { candidates: [{ content: { parts: [{ text: '{\"reply\":\"Aaj 9:00 AM - ICT\"}' }] } }] };
  const consumed = await handleGroupMessage(groupMsg('aj timetable kya hai?'));
  assert.equal(consumed, true);
  assert.ok(geminiCalls.length >= 1);
  assert.match(geminiCalls[0].url, /key=test-gemini-key/); // GOOGLE_API_KEY from env

  const get = await fetch(`${BASE}/api/admin/chatbot`, { headers: { cookie: adminCookie } });
  const json = await get.json();
  assert.equal(json.data.enabled, true);
  assert.equal(json.data.apiKeySource, 'env');
  assert.ok(!JSON.stringify(json).includes('test-gemini-key'), 'key value never exposed');
});

test('chatbot switch: non-boolean enabled is rejected', async () => {
  const put = await fetch(`${BASE}/api/admin/chatbot`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ enabled: 'yes' }),
  });
  assert.equal(put.status, 400);
});
