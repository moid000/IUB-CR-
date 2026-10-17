/** REGRESSION 2026-10-17 (claim-with-no-files, live evidence): a bare
 * subject answer ("OOP") right after a notes clarification must DELIVER
 * that subject's files even when the LLM answers with a claim text and
 * EMPTY send_note_titles ("*Notes — OOP*" with 0 files shipped twice in
 * production). Covers: parenthetical-subject-name aliasing ("Object
 * oriented programming (OOP)"), the notes-gate pick context, and the
 * deterministic pick-rescue. */
// eslint-disable-next-line
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const replset = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = replset.getUri('notes_bare_subject');
process.env.JWT_SECRET = 'test-only-jwt-secret-rr';
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
const { handleGroupMessage } = chatbot;
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
test.afterEach(async () => { waSent.length = 0; geminiPayload = null; chatbot.__resetGuards(); await ChatbotSetting.deleteMany({}); await ChatbotLog.deleteMany({}); });
const nowSec = () => Math.floor(Date.now() / 1000);
let msgCounter = 0;
const groupMsg = (body) => ({ event_type: 'message_received', instanceId: 'instance123',
  data: { id: `nbs-${++msgCounter}`, type: 'chat', fromMe: false, chatId: GROUP_ID, from: GROUP_ID,
    author: `${STUDENT}@c.us`, body: `@${process.env.ULTRAMSG_GATEWAY_PHONE} ${body}`.trim(), time: nowSec() } });
const filesSent = () => waSent.filter((s) => s.kind === 'document');

test.before(async () => {
  await Section.deleteMany({}); await Subject.deleteMany({}); await Note.deleteMany({});
  const dept = await Department.create({ name: 'AI Department', code: 'AID' });
  const session = await AcademicSession.create({ name: '2024-2028' });
  const sec = await Section.create({ name: '3M', semester: 2, department: dept._id, session: session._id,
    whatsappGroup: { id: GROUP_ID, name: 'General 3M' } });
  // PRODUCTION-LIKE subject records incl. the duplicate short 'AI'
  await Subject.create({ name: 'AI', code: 'AI-301', section: sec._id, status: 'active', createdBy: sec._id });
  const aiSubj = await Subject.create({ name: 'Artificial Intelligence', code: 'AI-201', section: sec._id, status: 'active', createdBy: sec._id });
  const oopSubj = await Subject.create({ name: 'Object oriented programming (OOP)', code: 'OOP-201', section: sec._id, status: 'active', createdBy: sec._id });
  await Note.create({ createdBy: sec._id, author: sec._id, title: 'Python Lec 3 Match Statement (PDF)', subject: oopSubj._id, section: sec._id,
    attachments: [{ publicId: 'p3', url: 'https://res.cloudinary.com/demo/p3.pdf', mimeType: 'application/pdf', originalName: 'p3.pdf' }] });
  await Note.create({ createdBy: sec._id, author: sec._id, title: 'Python lec 4 Loops (PDF)', subject: oopSubj._id, section: sec._id,
    attachments: [{ publicId: 'p4', url: 'https://res.cloudinary.com/demo/p4.pdf', mimeType: 'application/pdf', originalName: 'p4.pdf' }] });
  await Note.create({ createdBy: sec._id, author: sec._id, title: 'BS_AI_Semester_2_Lecture_3.pdf', subject: aiSubj._id, section: sec._id,
    attachments: [{ publicId: 'ai3', url: 'https://res.cloudinary.com/demo/ai3.pdf', mimeType: 'application/pdf', originalName: 'ai3.pdf' }] });
  await ChatbotSetting.create({ key: 'global', enabled: true, apiKey: 'test-gemini-key' });
});

test('REPRO: listing -> bare "OOP" with claim-text-only LLM answer -> rescue must deliver files', async () => {
  // step 1: notes listing (LLM asks which subject)
  geminiPayload = { reply: 'Kis subject ke notes chahiye? Available subjects: Artificial Intelligence, Object oriented programming (OOP)', send_note_titles: [], intent: 'class_info' };
  await handleGroupMessage(groupMsg('bhai notes'));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(waSent.some((s) => s.kind === 'chat'), 'listing reply sent');

  // step 2: bare subject answer, LLM gives claim text with EMPTY titles
  geminiPayload = { reply: '*Notes — Object oriented programming (OOP)* 📂', send_note_titles: [], intent: 'class_info' };
  waSent.length = 0;
  chatbot.__resetGuards(); // production had 14s spacing; skip only the cooldown
  await handleGroupMessage(groupMsg('OOP'));
  await new Promise((r) => setTimeout(r, 300));
  const docs = filesSent();
  console.log('FILES SENT:', docs.length);
  for (const s of waSent) console.log('WA:', s.kind, '|', String(s.params.body ?? s.params.link ?? '').slice(0, 90));
  const lastLog = await ChatbotLog.findOne({}).sort({ createdAt: -1 }).lean();
  console.log('LASTLOG reply:', String(lastLog?.reply).slice(0, 200));
  console.log('LASTLOG source:', lastLog?.source, 'sentFiles:', lastLog?.sentFiles);
  assert.ok(docs.length >= 1, 'rescue must deliver the OOP files');
});

test.after(async () => { server.close(); await mongoose.connection.close(); await replset.stop(); });
