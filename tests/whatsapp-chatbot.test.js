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
  buildFallbackReply, pickNotesForDelivery, isGroupMessage, groupIdOf,
} = chatbot;

const { Section, Subject, Note, Assignment, Timetable, ChatbotLog, Department, AcademicSession } = models;
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
    if (!geminiResponse) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(geminiResponse), { status: 200 });
  }
  return realFetch(url, opts);
};

test.afterEach(() => {
  waSent.length = 0;
  geminiCalls.length = 0;
  geminiResponse = null;
  chatbot.__resetGuards(); // fresh cooldown/hour/day budget per test
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
  assert.ok(String(geminiCalls[0].url).includes('gemini-2.5-flash'));
  assert.ok(String(geminiCalls[0].body.contents[0].parts[0].text).includes('B-204'));
  assert.equal(waSent.length, 1);
  assert.equal(waSent[0].kind, 'chat');
  assert.equal(waSent[0].params.to, GROUP_ID);
  assert.match(waSent[0].params.body, /ICT/);
  const log = await ChatbotLog.findOne({ groupId: GROUP_ID }).sort({ createdAt: -1 });
  assert.ok(log);
  assert.equal(log.source, 'gemini');
  assert.match(log.question, /class timing/);
});

test('Gemini down → keyword fallback still answers (no crash, no hallucination)', async () => {
  geminiResponse = null; // 500 from Gemini
  assert.equal(await handleGroupMessage(groupMsg('aj ka timetable batao?')), true);
  assert.equal(geminiCalls.length, 1);
  assert.equal(waSent.length, 1);
  assert.match(waSent[0].params.body, /9:00 AM/);
  const log = await ChatbotLog.findOne({ groupId: GROUP_ID }).sort({ createdAt: -1 });
  assert.equal(log.source, 'fallback');
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

test('fallback builder: today\'s classes, notes list and deadlines', async () => {
  const data = {
    timetable: [{ date: today, time: '9:00 AM – 10:30 AM', subject: 'ICT', room: 'B-204', status: 'Teacher confirmed ✅' }],
    subjects: [{ name: 'ICT', code: 'ICT-101' }],
    noteFileIndex: [{ title: 'Lecture 1 - Introduction', subject: 'ICT', hasFiles: true }],
    assignments: [{ title: 'Assignment 1', subject: 'ICT', deadline: 'soon', past: false }],
  };
  assert.match(buildFallbackReply('aj ki class?', data), /9:00 AM/);
  assert.match(buildFallbackReply('ICT ke notes', data), /Lecture 1/);
  assert.match(buildFallbackReply('assignments?', data), /Assignment 1/);
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
