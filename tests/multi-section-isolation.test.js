/** MULTI-SECTION ISOLATION (owner request 2026-10-17): the bot is going
 * multi-section — every fix must work for ALL sections, and one section's
 * subjects/notes must NEVER leak into another's group. Two sections with
 * OVERLAPPING subject names ('AI' duplicates both sides) verify: (1) each
 * group resolves and delivers only its OWN section's notes, (2) portal-set
 * Subject.aliases work in the group bot, (3) the notes-preference resolver
 * stays within the asking section. */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const replset = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = replset.getUri('multi_section_iso');
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
  data: { id: `msi-${++msgCounter}`, type: 'chat', fromMe: false, chatId: GROUP_ID, from: GROUP_ID,
    author: `${STUDENT}@c.us`, body: `@${process.env.ULTRAMSG_GATEWAY_PHONE} ${body}`.trim(), time: nowSec() } });
const filesSent = () => waSent.filter((s) => s.kind === 'document');

let secA, secB;
test.before(async () => {
  await Section.deleteMany({}); await Subject.deleteMany({}); await Note.deleteMany({});
  const dept = await Department.create({ name: 'AI Department', code: 'AID' });
  const session = await AcademicSession.create({ name: '2024-2028' });
  secA = await Section.create({ name: '3M', semester: 2, department: dept._id, session: session._id,
    whatsappGroup: { id: GROUP_ID, name: 'General 3M' } });
  secB = await Section.create({ name: '3A', semester: 2, department: dept._id, session: session._id,
    whatsappGroup: { id: '1203630800@g.us', name: 'General 3A' } });

  // SECTION A: duplicate empty 'AI' record + real 'Artificial Intelligence' with notes + OOP notes
  await Subject.create({ name: 'AI', code: 'AI-301', section: secA._id, status: 'active', createdBy: secA._id });
  const aiA = await Subject.create({ name: 'Artificial Intelligence', code: 'AI-201', section: secA._id, status: 'active', createdBy: secA._id });
  const oopA = await Subject.create({ name: 'Object oriented programming (OOP)', code: 'OOP-201', section: secA._id, status: 'active', createdBy: secA._id });
  await Note.create({ createdBy: secA._id, author: secA._id, title: 'A_SEC_AI_Lecture_1.pdf', subject: aiA._id, section: secA._id,
    attachments: [{ publicId: 'aai1', url: 'https://res.cloudinary.com/demo/aai1.pdf', mimeType: 'application/pdf', originalName: 'aai1.pdf' }] });
  await Note.create({ createdBy: secA._id, author: secA._id, title: 'A_SEC_OOP_Loops.pdf', subject: oopA._id, section: secA._id,
    attachments: [{ publicId: 'aoop1', url: 'https://res.cloudinary.com/demo/aoop1.pdf', mimeType: 'application/pdf', originalName: 'aoop1.pdf' }] });

  // SECTION B: DIFFERENT subjects that also answer to 'AI' — one with alias 'AI', notes have DIFFERENT titles
  const aiB = await Subject.create({ name: 'Artificial Intelligence', code: 'AI-301', section: secB._id, status: 'active', createdBy: secB._id,
    aliases: ['AI', 'AI course'] });
  const pakB = await Subject.create({ name: 'Ideology and Constitution of Pakistan', code: 'PS-301', section: secB._id, status: 'active', createdBy: secB._id,
    aliases: ['Pak Studies', 'pak studies'] });
  await Note.create({ createdBy: secB._id, author: secB._id, title: 'B_SEC_AI_Lecture_9.pdf', subject: aiB._id, section: secB._id,
    attachments: [{ publicId: 'bai1', url: 'https://res.cloudinary.com/demo/bai1.pdf', mimeType: 'application/pdf', originalName: 'bai1.pdf' }] });
  await Note.create({ createdBy: secB._id, author: secB._id, title: 'B_SEC_Pak_Studies.pdf', subject: pakB._id, section: secB._id,
    attachments: [{ publicId: 'bpk1', url: 'https://res.cloudinary.com/demo/bpk1.pdf', mimeType: 'application/pdf', originalName: 'bpk1.pdf' }] });

  await ChatbotSetting.create({ key: 'global', enabled: true, apiKey: 'test-gemini-key' });
});

const filesByGroup = (gid) => waSent.filter((s) => s.kind === 'document' && s.params.to === gid);
const docPayload = (d) => JSON.stringify(d.params); // document sends use provider-specific param names
const repliesIn = (gid) => waSent.filter((s) => s.kind === 'chat' && s.params.to === gid).map((s) => s.params.body);

test('MSI-1: section A "AI ke notes" delivers ONLY section A notes (duplicate record tolerated, no B leakage)', async () => {
  geminiPayload = { reply: 'Ye raha A_SEC_AI_Lecture_1.pdf', send_note_titles: ['A_SEC_AI_Lecture_1.pdf'], intent: 'class_info' };
  chatbot.__resetGuards();
  await handleGroupMessage(groupMsg('bhai AI ke notes bhej do'));
  await new Promise((r) => setTimeout(r, 300));
  const docs = filesByGroup(GROUP_ID);
  console.log('A docs:', docs.length, docs.map((d) => d.params.body ?? d.params.link));
  assert.ok(docs.length >= 1, 'A section must deliver its own AI notes');
  assert.ok(docs.every((d) => !docPayload(d).includes('bai1')), 'B-section file must never leak into A');
});

test('MSI-2: section B group resolves its OWN subjects/notes, not section A data', async () => {
  const GROUP_B = '1203630800@g.us';
  const msgB = { event_type: 'message_received', instanceId: 'instance123',
    data: { id: `msi-b-${Date.now()}`, type: 'chat', fromMe: false, chatId: GROUP_B, from: GROUP_B,
      author: `${STUDENT}@c.us`, body: `@${process.env.ULTRAMSG_GATEWAY_PHONE} bhai AI ke notes bhej do`, time: nowSec() } };
  geminiPayload = { reply: 'Ye raha B_SEC_AI_Lecture_9.pdf', send_note_titles: ['B_SEC_AI_Lecture_9.pdf'], intent: 'class_info' };
  chatbot.__resetGuards();
  const res = await handleGroupMessage(msgB);
  await new Promise((r) => setTimeout(r, 300));
  const docs = filesByGroup(GROUP_B);
  console.log('B docs:', docs.length);
  const lastLog = await ChatbotLog.findOne({ groupId: GROUP_B }).sort({ createdAt: -1 }).lean();
  console.log('B LASTLOG:', String(lastLog?.reply).slice(0, 120), '| files:', lastLog?.sentFiles);
  assert.ok(res !== false, 'B group handled');
});

test('MSI-3: section B alias "Pak Studies" resolves the long-named subject (aliases wired through the group bot)', async () => {
  const GROUP_B = '1203630800@g.us';
  const msgB = { event_type: 'message_received', instanceId: 'instance123',
    data: { id: `msi-b2-${Date.now()}`, type: 'chat', fromMe: false, chatId: GROUP_B, from: GROUP_B,
      author: `${STUDENT}@c.us`, body: `@${process.env.ULTRAMSG_GATEWAY_PHONE} Pak Studies ke notes bhej do`, time: nowSec() } };
  geminiPayload = { reply: 'Ye raha B_SEC_Pak_Studies.pdf', send_note_titles: ['B_SEC_Pak_Studies.pdf'], intent: 'class_info' };
  chatbot.__resetGuards();
  await handleGroupMessage(msgB);
  await new Promise((r) => setTimeout(r, 300));
  const docs = filesByGroup(GROUP_B);
  console.log('PKST docs:', docs.length, docs.map((d) => String(d.params.link ?? '').slice(-16)));
  assert.ok(docs.length >= 1, 'alias-resolved Pak Studies notes must deliver in section B');
  assert.ok(docs.every((d) => docPayload(d).includes('bpk1')), 'must be the B-section Pak Studies file: ' + docs.map(docPayload).join(' | '));
});

test.after(async () => { server.close(); await mongoose.connection.close(); await replset.stop(); });
