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
process.env.OPENAI_API_KEY = 'sk-test-whisper';
process.env.ULTRAMSG_WEBHOOK_SECRET = 'whsec-test';
process.env.WHATSAPP_CHATBOT_ENABLED = 'true';
process.env.GOOGLE_API_KEY = 'test-gemini-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { env } = await import('../backend/config/env.js');
const chatbot = await import('../backend/services/chatbotService.js');
const {
  handleGroupMessage, isTri3mTag, stripMentions, parseGeminiJson,
  buildFallbackReply, pickNotesForDelivery, isGroupMessage, groupIdOf, contextData, subjectAsked,
  resolvePick, resolveLastNotes, extractOfferedTitles, SYSTEM_PROMPT, miniGameReply, casualReply, resolveSubjectFollowUp,
  isVoiceAddressedToBot, transcribeVoice, resolveOpenAiKey,
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
let openaiTranscript = null; // canned Whisper transcript per test
const openaiCalls = [];

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
  if (u.includes('voice.test.local')) {
    return new Response(new Uint8Array([79, 103, 103, 83, 0, 12]).buffer, { status: 200 }); // fake ogg bytes
  }
  if (u.includes('api.openai.com')) {
    openaiCalls.push({ url: u, auth: String(opts?.headers?.authorization ?? '') });
    return new Response(JSON.stringify({ text: openaiTranscript ?? '' }), { status: 200 });
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
  openaiCalls.length = 0;
  openaiTranscript = null;
  chatbot.__resetGuards(); // fresh cooldown/hour/day budget per test
  await ChatbotSetting.deleteMany({}); // panel switch resets to env defaults
  await ChatbotLog.deleteMany({}); // group memory must not leak between tests
});

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const nowSec = () => Math.floor(Date.now() / 1000);

/** UltraMsg-shaped inbound group message payload. */
function groupMsg(body, { author = STUDENT, time = null, chatId = GROUP_ID, tagged = true } = {}) {
  // OWNER RULE (2026-10-05): the bot speaks only when tagged, so by default
  // test payloads arrive tagged (like a real "@Tri3M" WhatsApp mention).
  const text = tagged ? `@${process.env.ULTRAMSG_GATEWAY_PHONE} ${body}`.trim() : body;
  return {
    event_type: 'message_received',
    instanceId: 'instance123',
    data: {
      id: 'TESTID123', type: 'chat', fromMe: false,
      chatId, from: chatId, author: `${author}@c.us`,
      body: text, time: time ?? nowSec(),
    },
  };
}

/** UltraMsg-shaped inbound VOICE note in a group. */
function voiceMsg({ author = STUDENT, link = 'https://voice.test.local/voice.ogg' } = {}) {
  return {
    event_type: 'message_received',
    instanceId: 'instance123',
    data: {
      id: 'VOICEID123', type: 'audio', fromMe: false,
      chatId: GROUP_ID, from: GROUP_ID, author: `${author}@c.us`,
      body: '', link, time: nowSec(),
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

test('isTri3mTag: ONLY an explicit @tag wakes the bot (owner rule 2026-10-05)', () => {
  const G = process.env.ULTRAMSG_GATEWAY_PHONE;
  assert.equal(isTri3mTag(`@${G} aaj ki class?`, G), true); // real WhatsApp tag form
  assert.equal(isTri3mTag('han @Tri3M notes do', G), true); // literal text form
  assert.equal(isTri3mTag('aaj class kitni baje hai', G), false); // keyword, no tag
  assert.equal(isTri3mTag('class kitni baje?', G), false); // question mark, no tag
  assert.equal(isTri3mTag('hi bot', G), false); // address without @
  assert.equal(isTri3mTag('tri3m bhai', G), false); // plain name text = silent
  assert.equal(isTri3mTag('@923007770001 suno', G), false); // someone ELSE tagged
  assert.equal(isTri3mTag('', G), false);
});

test('owner rule (2026-10-05): untagged messages never wake the bot — admins/students stay unanswered', async () => {
  // the owner's exact complaint: other group admins post announcements and
  // the bot used to answer with the dry "mujhe kuch nahi pata" template.
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{"reply":"nahi bataunga"}' }] } }] };
  for (const body of [
    'aaj class kitni baje hai', // class keyword
    'kal ki class kitni baje?', // keyword + question mark
    '📅 Timetable updated — class added: ICT, aaj 9:00 AM', // admin announcement
    '📢 New announcement: quiz next week', // another admin post
    'hi bot', // direct address, no @
    'tri3m bhai notes do', // plain name text
    'ye wala note bhej do', // a pick, but untagged
  ]) {
    assert.equal(await handleGroupMessage(groupMsg(body, { tagged: false })), true);
  }
  assert.equal(geminiCalls.length, 0); // zero LLM spend
  assert.equal(waSent.length, 0); // and never a reply — silence, as ordered
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

test('casual chat is consumed silently when untagged — no LLM spend', async () => {
  // tagged casual always gets banter (see the TAGGED casual test below);
  // untagged casual is silence under the 2026-10-05 owner rule
  assert.equal(await handleGroupMessage(groupMsg('kya haal hai doston', { tagged: false })), true);
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

test('owner rule (2026-10-05): notes/assignment requests ASK for the subject first — never dump all subjects', async () => {
  // no subject -> ONE short question, zero notes listed
  for (const q of ['notes bhej do', 'notes chahiye', 'notes send krdo', 'mujhe notes chahiye', 'bhai notes mil sakty']) {
    const r = buildFallbackReply(q, FALLBACK_DATA);
    assert.match(r, /kis subject ke notes chahiye\?/i, `must ask subject for: ${q}`);
    assert.doesNotMatch(r, /Lecture 1/, `must NOT list notes for: ${q}`);
  }
  // subject named -> ONLY that subject's notes
  const ict = buildFallbackReply('ICT ke notes bhej do', FALLBACK_DATA);
  assert.match(ict, /Lecture 1/);
  assert.match(ict, /Notes \u2014 ICT|Notes - ICT|Notes\* \u2014 ICT|Notes/i);
  // explicit "all subjects" -> full list allowed
  assert.match(buildFallbackReply('sab subjects ke notes bhej do', FALLBACK_DATA), /Lecture 1/);
  // assignment request without subject -> asks; with subject -> only that subject
  for (const q of ['assignment bhej do', 'mujhe assignment chahiye', 'assignment send krdo']) {
    assert.match(buildFallbackReply(q, FALLBACK_DATA), /kis subject ki assignment chahiye\?/i, `must ask subject for: ${q}`);
  }
  assert.match(buildFallbackReply('ICT ki assignment bhej do', FALLBACK_DATA), /Assignment 1/);
  // deadline INFO questions still list upcoming work (subjects labeled, not a guess)
  assert.match(buildFallbackReply('kya deadlines hain?', FALLBACK_DATA), /Assignment 1/);
});

test('owner rule (2026-10-05): bare subject answer ("ICT") after the bot asked resolves via context', async () => {
  const lastLog = { reply: 'Kis subject ke notes chahiye? Class ke subjects: ICT, Programming, Artificial Intelligence', createdAt: new Date() };
  const r = resolveSubjectFollowUp('ICT', lastLog, FALLBACK_DATA);
  assert.ok(r, 'follow-up resolves');
  assert.match(r.reply, /Lecture 1/);
  assert.deepEqual(r.titles, ['Lecture 1 - Introduction']); // hasFiles -> queued for delivery
  // a DIFFERENT subject means the same follow-up returns that subject only
  const r2 = resolveSubjectFollowUp('Programming', lastLog, FALLBACK_DATA);
  assert.match(r2.reply, /published notes nahi mile/); // Programming has no notes
  // assignment clarification resolves to assignments
  const lastAssign = { reply: 'Kis subject ki assignment chahiye?', createdAt: new Date() };
  const r3 = resolveSubjectFollowUp('ICT', lastAssign, FALLBACK_DATA);
  assert.match(r3.reply, /Assignment 1/);
  // no clarification in the last turn -> not a follow-up
  assert.equal(resolveSubjectFollowUp('ICT', { reply: 'Aaj 9:00 AM — ICT' }, FALLBACK_DATA), null);
});

test('owner rule (2026-10-05): end-to-end — "notes bhej do" asks the subject, bare "ICT" then delivers ICT files', async () => {
  geminiResponse = null; // Gemini down -> fallback path must handle it alone
  assert.equal(await handleGroupMessage(groupMsg('notes bhej do')), true);
  const ask = waSent.find((st) => st.kind === 'chat');
  assert.ok(ask, 'clarification sent');
  assert.match(ask.params.body, /kis subject ke notes chahiye\?/i);
  assert.ok(!waSent.some((st) => st.kind === 'document'), 'no files sent before the subject is known');
  chatbot.__resetGuards(); // clear the per-group cooldown
  assert.equal(await handleGroupMessage(groupMsg('ICT')), true);
  const after = waSent.filter((st) => st.kind === 'chat').at(-1);
  assert.match(after.params.body, /Lecture 1/);
  assert.ok(waSent.some((st) => st.kind === 'document'), 'ICT note files delivered');
});

test('owner feature (2026-10-05): VOICE NOTES — transcribed voice that addresses the bot gets answered', async () => {
  geminiResponse = null; // fallback path must answer alone
  openaiTranscript = 'tri 3m bhai notes bhej do'; // spoken tag, no @ possible
  assert.equal(await handleGroupMessage(voiceMsg()), true);
  assert.equal(openaiCalls.length, 1); // Whisper was called once
  const chat = waSent.find((st) => st.kind === 'chat');
  assert.ok(chat, 'voice question answered');
  assert.match(chat.params.body, /kis subject ke notes chahiye\?/i); // subject-first applies to voice too
});

test('owner rule (2026-10-05): voice that does NOT address the bot stays silent', async () => {
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{"reply":"haan haan"}' }] } }] };
  openaiTranscript = 'yaar kal match dekhna hai, kya scene hai'; // no tri3m/bot
  assert.equal(await handleGroupMessage(voiceMsg()), true);
  assert.equal(openaiCalls.length, 1); // transcription still happened
  assert.equal(waSent.length, 0); // but no reply — mention-only spirit
});

test('owner rule (2026-10-05): no OpenAI key -> voice notes are consumed silently, zero API spend', async () => {
  const hadKey = env.chatbot.openaiApiKey;
  env.chatbot.openaiApiKey = null;
  try {
    assert.equal(await handleGroupMessage(voiceMsg()), true);
    assert.equal(openaiCalls.length, 0);
    assert.equal(waSent.length, 0);
  } finally {
    env.chatbot.openaiApiKey = hadKey;
  }
});

test('isVoiceAddressedToBot: spoken forms only, no false "trim" hits', () => {
  assert.equal(isVoiceAddressedToBot('tri 3m bhai notes bhej do'), true);
  assert.equal(isVoiceAddressedToBot('tri3m kal ki class batao'), true);
  assert.equal(isVoiceAddressedToBot('tri threem salam'), true);
  assert.equal(isVoiceAddressedToBot('bot kia scene hai'), true);
  assert.equal(isVoiceAddressedToBot('trim the file please'), false); // 'trim' is NOT the bot
  assert.equal(isVoiceAddressedToBot('aaj class kitni baje hai'), false);
  assert.equal(isVoiceAddressedToBot(''), false);
});

test('isGroupMessage accepts voice/audio types (owner feature 2026-10-05)', () => {
  assert.equal(isGroupMessage(voiceMsg()), true);
  assert.equal(isGroupMessage(groupMsg('text', { tagged: false })), true);
  const notGroup = { event_type: 'message_received', data: { fromMe: false, type: 'audio', from: '923001119999@c.us' } };
  assert.equal(isGroupMessage(notGroup), false); // DM audio is teacher-flow territory
});

test('owner rule (2026-10-05): SYSTEM_PROMPT carries the subject-first intent rules', () => {
  assert.match(SYSTEM_PROMPT, /SUBJECT-FIRST/);
  assert.match(SYSTEM_PROMPT, /Kis subject ke notes chahiye\?/);
  assert.match(SYSTEM_PROMPT, /Kis subject ki assignment chahiye\?/);
  assert.match(SYSTEM_PROMPT, /never mix other subjects in/);
  assert.match(SYSTEM_PROMPT, /instead of guessing/);
  assert.match(SYSTEM_PROMPT, /FEW-SHOT/); // owner-spec example exchanges
  assert.match(SYSTEM_PROMPT, /VOICE \(owner feature 2026-10-05\)/);
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

  // subjects list question answers with the list (no catch-all deflection)
  const subs = buildFallbackReply('hamare subjects kaun ke hain?', FALLBACK_DATA);
  assert.match(subs, /ICT/);
  assert.match(subs, /Programming/);
  assert.match(subs, /Artificial Intelligence/);
  assert.match(subs, /\(AI-101\)/);

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

test('owner mini-game: "class ki phopho kon hai?" → spin lands on Warda and Arooj, funny but never hurtful', async () => {
  // unit: trigger words + fixed outcome
  const g1 = miniGameReply('yar is class ki phopho kon hai jo shitani karti hai?');
  assert.ok(g1);
  assert.match(g1, /Warda/);
  assert.match(g1, /Arooj/);
  assert.ok(miniGameReply('class ki phuppo kaun hai')); // spelling variant
  // owner tone update 17:30: FUNNY that makes everyone laugh — never mean.
  // No "fitna/tabahi/investigation" accusations, no over-soft "pyari/jaan".
  for (let i = 0; i < 12; i += 1) {
    const spin = miniGameReply('phopho kon hai?');
    assert.doesNotMatch(spin, /pyari|jaan/);
    assert.doesNotMatch(spin, /fitna|tabahi|investigation|PhD|Malik/i); // badtamezi words gone
    assert.match(spin, /(wheel|spin)/i);
    assert.match(spin, /(energetic|energy|entertaining|shitani)/i); // light funny framing
  }
  // unrelated questions are NOT hijacked
  assert.equal(miniGameReply('timetable kya hai aj ka'), null);
  assert.equal(miniGameReply('notes bhej do'), null);

  // end-to-end: answered WITHOUT calling Gemini (fixed game, zero LLM spend)
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{\"reply\":\"Gemini must not be called here.\",\"send_note_titles\":[]}' }] } }] };
  assert.equal(await handleGroupMessage(groupMsg('class ki phopho kon hai jo shitani karti hai?')), true);
  assert.equal(geminiCalls.length, 0, 'mini-game never spends an LLM call');
  const chat = waSent.find((s) => s.kind === 'chat');
  assert.ok(chat, 'reply sent');
  assert.ok(chat.params.body.startsWith(`@${STUDENT} `), 'mentions the asker');
  assert.match(chat.params.body, /Warda/);
  assert.match(chat.params.body, /Arooj/);
  // the log marks it as a fallback-source answer
  const log = await ChatbotLog.findOne({ groupId: GROUP_ID }).sort({ createdAt: -1 });
  assert.equal(log.source, 'fallback');
});

test('owner feature: CR/GR gets RESPECT, students get roast — casualReply leader mode', () => {
  assert.doesNotMatch(casualReply('kia hal hain', { leader: true }), /zinda|WiFi/); // never the roast tone
  assert.match(casualReply('kia hal hain', { leader: true }), /aap ka shukriya|hazir hoon/i);
  assert.match(casualReply('salam', { leader: true }), /Wa alaikum assalam/);
  assert.match(casualReply('dafa ho', { leader: true }), /maazrat/i); // polite, never roasted back
  assert.match(casualReply('', { leader: true }), /Ji boliye/);
  // buildFallbackReply catch-all is leader-aware too (never "apne CR se poochein" TO the CR)
  assert.match(buildFallbackReply('kuch ajeeb', {}, { leader: true }), /aap portal me check kar lein/i);
  assert.match(buildFallbackReply('kisi ka phone number batao', {}, { leader: true }), /portal me verify/i);
  // students keep the FUNNY tone (pool rotates — all 3 variants are light)
  const studentHaal = casualReply('kia hal hain', { leader: false });
  assert.ok(studentHaal && !/aap ka shukriya/.test(studentHaal));
  assert.match(studentHaal, /theek|mast|masst|haal/i);
  assert.doesNotMatch(studentHaal, /behtar hai tumhari|zinda hoon/i);
  assert.match(buildFallbackReply('kuch ajeeb', {}, { leader: false }), /apne CR se poochein/);
});

test('owner feature: TAGGED casual chat always gets a reply — casualReply helper', () => {
  // greetings
  assert.match(casualReply('salam doston'), /Wa alaikum assalam/);
  // "dafa ho" style banter → gentle witty comeback, never harsh
  const dafa = casualReply('dafa ho');
  assert.match(dafa, /helper hoon|mazak/i);
  assert.doesNotMatch(dafa, /complain|likhwa/); // no threats-as-jokes
  // "kaisay ho" → funny haal reply (even with a question mark)
  const haal = casualReply('kaisay ho?');
  assert.ok(haal);
  assert.match(haal, /theek|mast|masst|haal/i);
  assert.doesNotMatch(haal, /behtar hai tumhari|zinda hoon/i); // no mean jabs
  // Roman-Urdu spelling variants the owner actually types (regression:
  // 'kia hal hain' once fell through to the dry catch-all)
  for (const variant of ['kia hal hain', 'kya haal hai doston', 'kaise ho', 'kia hal', 'kese ho aap']) {
    assert.ok(casualReply(variant), `casual variant must banter: ${variant}`);
  }
  // bare tag (empty question after stripping) → witty prompt to ask something
  assert.match(casualReply(''), /sirf tag/);
  // study content is NEVER hijacked by the casual branch
  assert.equal(casualReply('aj ki class timing'), null);
  assert.equal(casualReply('ICT ke notes do'), null);
  assert.equal(casualReply('kuch ajeeb sa lamba message jo kisi pattern se nahi milta'), null);
});

test('owner feature: "@Tri3M kaisay ho" now REPLIES (mention no longer stripped before the trigger check)', async () => {
  // regression (2026-10-03): the tag was stripped before the trigger check, so tagged casual
  // chat was consumed silently — the exact bug the owner reported
  geminiResponse = null; // even with Gemini down the banter path answers
  assert.equal(await handleGroupMessage(groupMsg('@Tri3M kaisay ho')), true);
  const chat = waSent.find((s) => s.kind === 'chat');
  assert.ok(chat, 'casual reply sent');
  assert.ok(chat.params.body.startsWith(`@${STUDENT} `));
  assert.doesNotMatch(chat.params.body, /Ye mere paas nahi hai/); // never the dry catch-all
  assert.match(chat.params.body, /theek|mast|masst|haal/i);
  assert.doesNotMatch(chat.params.body, /zinda hoon|WiFi ka load/i); // no mean jabs
  // and the plain "dafa ho" tag gets the witty comeback
  chatbot.__resetGuards();
  assert.equal(await handleGroupMessage(groupMsg('@Tri3M dafa ho')), true);
  const chat2 = waSent.filter((s) => s.kind === 'chat').at(-1);
  assert.match(chat2.params.body, /helper hoon/);
});

test('owner feature: the section CR/GR gets a RESPECTFUL reply in the group', async () => {
  // make STUDENT the CR of the section
  const crUser = await User.create({ name: 'CR Sahab', email: `cr-lead-${Date.now()}@chatbot-test.local`, password: 'Pass#12345678', role: 'cr', section: section._id, phone: `+${STUDENT}` });
  section.cr = crUser._id;
  await section.save();

  // casual: respectful, not roast (Gemini down path)
  geminiResponse = null;
  assert.equal(await handleGroupMessage(groupMsg('@Tri3M kia hal hain')), true);
  const chat = waSent.find((s) => s.kind === 'chat');
  assert.ok(chat);
  assert.ok(chat.params.body.startsWith(`@${STUDENT} `));
  assert.match(chat.params.body, /aap ka shukriya|hazir hoon/i);
  assert.doesNotMatch(chat.params.body, /zinda hoon|WiFi/);

  // Gemini path: the CR/GR respect NOTE reaches the LLM
  chatbot.__resetGuards();
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{\"reply\":\"Ji bilkul.\",\"send_note_titles\":[]}' }] } }] };
  assert.equal(await handleGroupMessage(groupMsg('timetable?')), true);
  const lastUser = geminiCalls.at(-1).body.contents.at(-1).parts[0].text;
  assert.match(lastUser, /CR\/GR/);
  assert.match(lastUser, /FULL RESPECT/i);

  // GR is respected too
  chatbot.__resetGuards();
  geminiResponse = null; // fallback leader path must answer the GR too
  const grUser = await User.create({ name: 'GR Sahab', email: `gr-lead-${Date.now()}@chatbot-test.local`, password: 'Pass#12345678', role: 'gr', section: section._id, phone: '+923007770099' });
  section.gr = grUser._id;
  await section.save();
  assert.equal(await handleGroupMessage(groupMsg('salam @Tri3M', { author: '923007770099' })), true);
  const chat2 = waSent.filter((s) => s.kind === 'chat').at(-1);
  assert.match(chat2.params.body, /Wa alaikum assalam/);
  assert.doesNotMatch(chat2.params.body, /sirf salam/);

  // a REGULAR student in the same group still gets the roast tone
  chatbot.__resetGuards();
  geminiResponse = null;
  assert.equal(await handleGroupMessage(groupMsg('@Tri3M kia hal hain', { author: '923007770222' })), true);
  const chat3 = waSent.filter((s) => s.kind === 'chat').at(-1);
  assert.match(chat3.params.body, /theek|mast|masst/i);
  assert.doesNotMatch(chat3.params.body, /aap ka shukriya/);
});

test('owner feature: Gemini receives the group conversation history (continuous chat memory)', async () => {
  await ChatbotLog.create({ section: section._id, groupId: GROUP_ID, source: 'gemini', question: 'kal ki class hai?', reply: 'Haan, 9 AM ICT.' });
  await ChatbotLog.create({ section: section._id, groupId: GROUP_ID, source: 'gemini', question: 'notes kaun se hain?', reply: 'Lecture 1 - Introduction available hai.' });
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{\"reply\":\"ok\",\"send_note_titles\":[]}' }] } }] };
  assert.equal(await handleGroupMessage(groupMsg('timetable?')), true);
  const lastUser = geminiCalls[0].body.contents.at(-1).parts[0].text;
  assert.match(lastUser, /MEMORY/);
  assert.match(lastUser, /kal ki class hai\?/); // history is passed, oldest first
  assert.match(lastUser, /notes kaun se hain\?/);
  assert.match(lastUser, /Lecture 1 - Introduction/);
  const idxFirst = lastUser.indexOf('kal ki class');
  const idxSecond = lastUser.indexOf('notes kaun se');
  assert.ok(idxFirst >= 0 && idxSecond > idxFirst, 'oldest-first ordering');
});

test('owner feature: group reply @mentions the student who asked (busy-group clarity)', async () => {
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{\"reply\":\"Aaj ICT ki class 9:00 AM hai.\",\"send_note_titles\":[]}' }] } }] };
  assert.equal(await handleGroupMessage(groupMsg('aj ki class timing?')), true);
  const chat = waSent.find((s) => s.kind === 'chat');
  assert.ok(chat, 'reply sent');
  assert.ok(chat.params.body.startsWith(`@${STUDENT} `), 'reply opens with the asker mention');
  assert.match(chat.params.body, /9:00 AM/);
  const mentioned = JSON.parse(chat.params.mentionedIds);
  assert.deepEqual(mentioned, [STUDENT]);
  // fallback replies mention too
  geminiResponse = null;
  assert.equal(await handleGroupMessage(groupMsg('hamare subjects kaun ke hain?')), true);
  const chat2 = waSent.filter((s) => s.kind === 'chat').at(-1);
  assert.ok(chat2.params.body.startsWith(`@${STUDENT} `));
});

test('owner feature: prompt carries recency rule, two-step pick, memory and the funny personality', () => {
  assert.match(SYSTEM_PROMPT, /NEWEST-first/i);
  assert.match(SYSTEM_PROMPT, /TWO-STEP PICK/);
  assert.match(SYSTEM_PROMPT, /MEMORY/);
  assert.match(SYSTEM_PROMPT, /LEADER RESPECT/); // CR/GR gets full respect
  assert.match(SYSTEM_PROMPT, /CASUAL CHAT/); // tagged banter always gets banter back
  assert.match(SYSTEM_PROMPT, /CONVERSATION HISTORY/); // memory rule knows the history format
  assert.match(SYSTEM_PROMPT, /witty/i);
  assert.match(SYSTEM_PROMPT, /FUNNY/i); // humor that makes the group laugh
  assert.match(SYSTEM_PROMPT, /WHOLE GROUP laugh together/i);
  assert.match(SYSTEM_PROMPT, /no badtamezi/i); // respect limit is explicit
  assert.match(SYSTEM_PROMPT, /never target a person/i); // hard limit
  assert.doesNotMatch(SYSTEM_PROMPT, /never tease any student or teacher by name/);
  assert.match(SYSTEM_PROMPT, /EXACT title/i);
});

test('owner feature: "last time jo notes diye" picks the NEWEST note of the subject (fallback)', () => {
  const dataJson = {
    subjects: [{ name: 'ICT', code: 'ICT-101' }],
    noteFileIndex: [
      { title: 'Lecture 2 - New', subject: 'ICT', hasFiles: true, date: '2 Oct' },
      { title: 'Lecture 1 - Old', subject: 'ICT', hasFiles: true, date: '20 Sep' },
    ],
  };
  const r = resolveLastNotes('last time sir ne ICT ke jo notes diye the?', dataJson);
  assert.ok(r);
  assert.match(r.reply, /Lecture 2 - New/);
  assert.deepEqual(r.titles, ['Lecture 2 - New']);
  // unrelated question → no hijack
  assert.equal(resolveLastNotes('ICT ke notes do', dataJson), null);
});

test('owner feature: two-step pick — "ye wala" resolves against the last offered titles (fallback)', () => {
  const dataJson = {
    noteFileIndex: [
      { title: 'Lecture 1 - Introduction', subject: 'ICT', hasFiles: true, date: '1 Oct' },
      { title: 'Lecture 2 - Logic Gates', subject: 'ICT', hasFiles: false, date: '2 Oct' },
    ],
    assignments: [{ title: 'Assignment 1', subject: 'ICT', deadline: 'Mon 5 Oct', past: false }],
  };
  // ordinal pick → second offered title (no files → says so, sends nothing)
  const r = resolvePick('dusra wala do', { offeredTitles: ['Lecture 1 - Introduction', 'Lecture 2 - Logic Gates'] }, dataJson);
  assert.ok(r);
  assert.match(r.reply, /Lecture 2 - Logic Gates/);
  assert.deepEqual(r.titles, []);
  // single offered + "ye wala" → that one, files delivered
  const r2 = resolvePick('ye wala note bhej do', { offeredTitles: ['Lecture 1 - Introduction'] }, dataJson);
  assert.ok(r2);
  assert.match(r2.reply, /Lecture 1 - Introduction/);
  assert.deepEqual(r2.titles, ['Lecture 1 - Introduction']);
  // fragment of the title ("assignment 1 wala") → assignment details with deadline
  const r3 = resolvePick('assignment 1 wala bata do', { offeredTitles: ['Assignment 1', 'Lecture 1 - Introduction'] }, dataJson);
  assert.ok(r3);
  assert.match(r3.reply, /Assignment 1/);
  assert.match(r3.reply, /Mon 5 Oct/);
  // a fresh full question is NOT hijacked as a pick
  assert.equal(resolvePick('last time jo sir ne notes diye the ICT ke, wo bhejo please mjhe', { offeredTitles: ['Lecture 1 - Introduction'] }, dataJson), null);
});

test('owner feature: extractOfferedTitles logs exactly what the reply listed', () => {
  const dataJson = {
    noteFileIndex: [{ title: 'Lecture 1 - Introduction', subject: 'ICT', hasFiles: true, date: '' }],
    assignments: [{ title: 'Assignment 1', subject: 'ICT', deadline: '', past: false }],
  };
  const offered = extractOfferedTitles('Ye hain notes: Lecture 1 - Introduction. Aur Assignment 1 bhi pending hai.', dataJson, ['Extra Delivered']);
  assert.ok(offered.includes('Lecture 1 - Introduction'));
  assert.ok(offered.includes('Assignment 1'));
  assert.ok(offered.includes('Extra Delivered'));
});

test('owner feature: pick flow end-to-end — bot offered, student says "ye wala", files arrive', async () => {
  await ChatbotLog.create({
    section: section._id, groupId: GROUP_ID,
    question: 'ICT ke notes kaun se hain?', source: 'fallback',
    reply: 'Ye hain: Lecture 1 - Introduction, Lecture 2 - Logic Gates',
    offeredTitles: ['Lecture 1 - Introduction', 'Lecture 2 - Logic Gates'],
  });
  geminiResponse = null; // Gemini busy → the fallback pick path must work too
  // "dusra wala" → second offered title (Logic Gates, no files → says so)
  assert.equal(await handleGroupMessage(groupMsg('dusra wala note bhej do')), true);
  let chat = waSent.find((s) => s.kind === 'chat');
  assert.ok(chat, 'text reply sent');
  assert.match(chat.params.body, /Lecture 2 - Logic Gates/);
  // single offer + "ye wala" → that note's files delivered
  chatbot.__resetGuards(); // msg1 started the 8s group cooldown
  await ChatbotLog.deleteMany({}); // msg1's own log must not shadow this one
  await ChatbotLog.create({
    section: section._id, groupId: GROUP_ID, source: 'fallback',
    question: 'x', reply: 'Latest: Lecture 1 - Introduction',
    offeredTitles: ['Lecture 1 - Introduction'],
  });
  assert.equal(await handleGroupMessage(groupMsg('ye wala note bhej do')), true);
  chat = waSent.filter((s) => s.kind === 'chat').at(-1);
  assert.match(chat.params.body, /Lecture 1 - Introduction/);
  const doc = waSent.find((s) => s.kind === 'document');
  assert.ok(doc, 'picked note files delivered');
  assert.equal(doc.params.document, 'https://res.cloudinary.com/demo/n1.pdf');
});

test('owner feature: last-notes question end-to-end — newest note with files is delivered (fallback)', async () => {
  await Note.create({ createdBy: section._id, author: section._id,
    title: 'Lecture 3 - Pointers', subject: subject._id, section: section._id,
    attachments: [{ publicId: 'p3', url: 'https://res.cloudinary.com/demo/n3.pdf', mimeType: 'application/pdf', originalName: 'ptr.pdf' }],
  }); // newest (created last)
  geminiResponse = null;
  assert.equal(await handleGroupMessage(groupMsg('last time sir ny jo notes diye the ICT ke, wo bhej do')), true);
  const doc = waSent.find((s) => s.kind === 'document');
  assert.ok(doc, 'newest note files delivered');
  assert.equal(doc.params.document, 'https://res.cloudinary.com/demo/n3.pdf');
  assert.match(waSent.find((s) => s.kind === 'chat').params.body, /Lecture 3 - Pointers/);
});

test('owner feature: Gemini gets the group MEMORY so "ye wala" resolves over the LLM too', async () => {
  await ChatbotLog.create({
    section: section._id, groupId: GROUP_ID, source: 'gemini',
    question: 'ICT ke notes?', reply: 'Ye hain: Lecture 1 - Introduction',
    offeredTitles: ['Lecture 1 - Introduction'],
  });
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{\"reply\":\"Ye raha Lecture 1 - Introduction.\",\"send_note_titles\":[\"Lecture 1 - Introduction\"]}' }] } }] };
  assert.equal(await handleGroupMessage(groupMsg('ye wala do')), true);
  const lastUser = geminiCalls[0].body.contents.at(-1).parts[0].text;
  assert.match(lastUser, /MEMORY/);
  assert.match(lastUser, /Lecture 1 - Introduction/);
  assert.ok(geminiCalls.length >= 1);
});

test('owner feature: reply logs the offered titles it listed (memory for the next pick)', async () => {
  geminiResponse = { candidates: [{ content: { parts: [{ text: '{\"reply\":\"Notes hain: Lecture 1 - Introduction aur Lecture 2 - Logic Gates.\",\"send_note_titles\":[]}' }] } }] };
  assert.equal(await handleGroupMessage(groupMsg('ICT ke notes kaun se hain?')), true);
  const log = await ChatbotLog.findOne({ groupId: GROUP_ID }).sort({ createdAt: -1 });
  assert.ok(log.offeredTitles.includes('Lecture 1 - Introduction'));
  assert.ok(log.offeredTitles.includes('Lecture 2 - Logic Gates'));
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

test('voice key (owner fix 2026-10-08): panel-saved OpenAI key wins over env, used by Whisper, never leaked', async () => {
  // the switch's current state must be untouched by a key-only update
  const before = await (await fetch(`${BASE}/api/admin/chatbot`, { headers: { cookie: adminCookie } })).json();
  const enabledBefore = before.data.enabled === true;

  const put = await fetch(`${BASE}/api/admin/chatbot`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ openaiApiKey: 'sk-panel-secret-key-12345' }),
  });
  assert.equal(put.status, 200);
  const json = await put.json();
  assert.equal(json.data.openaiKeyConfigured, true);
  assert.equal(json.data.openaiKeySource, 'panel');
  assert.equal(json.data.enabled, enabledBefore); // key-only update does not flip the switch
  assert.ok(!JSON.stringify(json).includes('sk-panel-secret-key-12345'), 'PUT never echoes the key');

  const get = await fetch(`${BASE}/api/admin/chatbot`, { headers: { cookie: adminCookie } });
  const getJson = await get.json();
  assert.equal(getJson.data.openaiKeySource, 'panel');
  assert.ok(!JSON.stringify(getJson).includes('sk-panel-secret-key-12345'), 'GET never returns the key');

  // Whisper uses the PANEL key even when the env var is unset
  const hadKey = env.chatbot.openaiApiKey;
  env.chatbot.openaiApiKey = null;
  try {
    openaiTranscript = 'tri 3m bhai kal ki class ka time batao';
    openaiCalls.length = 0;
    const transcript = await transcribeVoice({ link: 'https://voice.test.local/voice.ogg' });
    assert.equal(transcript, 'tri 3m bhai kal ki class ka time batao');
    assert.ok(openaiCalls.length >= 1, 'Whisper was called');
    assert.equal(openaiCalls[0].auth, 'Bearer sk-panel-secret-key-12345');
    assert.equal(await resolveOpenAiKey(), 'sk-panel-secret-key-12345');
  } finally {
    env.chatbot.openaiApiKey = hadKey;
    openaiTranscript = null;
  }

  // clearing the panel key falls back to the env var
  const clear = await fetch(`${BASE}/api/admin/chatbot`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ openaiApiKey: '' }),
  });
  assert.equal(clear.status, 200);
  const clearJson = await clear.json();
  assert.equal(clearJson.data.openaiKeyConfigured, true); // env sk-test-whisper still there
  assert.equal(clearJson.data.openaiKeySource, 'env');
  assert.equal(await resolveOpenAiKey(), 'sk-test-whisper');
});

test('voice key (owner fix 2026-10-08): invalid key values and empty updates rejected', async () => {
  for (const [label, body] of [
    ['no sk- prefix', { openaiApiKey: 'not-a-real-key-aaaaaaaaaa' }],
    ['too short', { openaiApiKey: 'sk-short' }],
    ['nothing to update', {}],
  ]) {
    const put = await fetch(`${BASE}/api/admin/chatbot`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify(body),
    });
    assert.equal(put.status, 400, label);
  }
});
