/**
 * OWNER SPEC 2026-10-18 — "COMPLETE SUBJECT NOTES RETRIEVAL & ORDERED
 * MULTI-FILE DELIVERY" end-to-end suite, through the REAL pipeline
 * (Gemini mocked at fetch, WhatsApp gateway mocked at fetch, delivery
 * jobs REAL in MongoDB):
 *
 * CD-A  13 eligible files -> manifest 13, all 13 sent, one job, seq 1..13
 * CD-B  counts 1, 2, 10, 15 -> full sets, never truncated
 * CD-C  stable order across repeated runs (newest-first, _id tie-breaker)
 * CD-D  mixed file types -> images sent as image, others as document;
 *       missing mimeType falls back to document (never breaks delivery)
 * CD-E  one file fails mid-batch -> others sent, honest summary NAMES the
 *       failed file, sent files never resent on the sweep re-run
 * CD-F  duplicate webhook (same msgId) -> ONE job, files sent exactly once
 * CD-G  two workers race the same job concurrently -> atomic claims mean
 *       every file submitted exactly once
 * CD-H  worker dies with a file claimed ('sending') -> never blind-resent;
 *       sweep marks it 'unknown'; remaining files resume
 * CD-I  subject isolation -> one subject's ask never ships another's files
 * CD-J  listing ask ("kon se hain?") -> zero files sent
 * CD-K  casual joke -> zero files sent
 * CD-L  stale 'sending' recovery + bounded attempts (no infinite retries)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const replset = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = replset.getUri('notes_complete_test');
process.env.JWT_SECRET = 'test-only-jwt-secret-cd';
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
const { handleGroupMessage, createNotesDeliveryJob, runDeliveryJob, runNoteDeliverySweep, pickNotesForDelivery, __resetGuards } = chatbot;

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
    if (/\/messages\/(document|image|audio|video)$/.test(u) && /poison\.pdf/.test(String(opts.body ?? ''))) {
      waSent.push({ kind: u.match(/\/(document|image|audio|video)$/) ? u.split('/messages/')[1] : '?', body: String(opts.body ?? '') });
      return new Response(JSON.stringify({ error: 'provider media fetch failed' }), { status: 500 });
    }
    waSent.push({ kind: u.match(/\/messages\/(\w+)$/)?.[1] ?? '?', body: String(opts.body ?? '') });
    return new Response(JSON.stringify({ sent: true, msgId: 'prov-' + (waSent.length) }), { status: 200 });
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    geminiCalls.push(1);
    const parsed = JSON.parse(geminiPayload.reply ?? '{}');
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(parsed) }] } }],
    }), { status: 200 });
  }
  return realFetch(url, opts);
};

let n = 0;
const uniq = () => `x${++n}`;
const GROUP_ID = '1203630cd-suite@g.us';
const ASKER = '923001112233';
const SELF = '923001234567';

let section, oop, pf, authorId;
async function seed({ oopFileCount = 13, pfFileCount = 2 } = {}) {
  await mongoose.connection.db.dropDatabase();
  // dropDatabase wipes collection indexes — recreate them so the msgId
  // unique wall (duplicate-webhook idempotency) holds in EVERY test
  await Promise.all(Object.values(models).filter((m) => typeof m?.syncIndexes === 'function').map((m) => m.syncIndexes()));
  __resetGuards(); // cooldown/hour caps must not silence a later test's ask
  const dept = await Department.create({ name: 'CS Department', code: 'CSD' });
  const session = await AcademicSession.create({ name: '2026' });
  section = await Section.create({
    name: 'BSCS-6A', semester: 6, department: dept._id, session: session._id,
    whatsappGroup: { id: GROUP_ID, name: 'BSCS-6A General' },
  });
  authorId = (await User.create({ name: 'Sir Teacher', email: 'teacher@test.local', password: 'Pass123!', role: 'student', section: section._id, phone: '923005550001' }))._id;
  oop = await Subject.create({ section: section._id, name: 'Object oriented programming (OOP)', code: 'CS-301', status: 'active', createdBy: section._id });
  pf = await Subject.create({ section: section._id, name: 'Programming Fundamentals', code: 'CS-101', status: 'active', createdBy: section._id });
  for (let i = 0; i < oopFileCount; i += 1) {
    await Note.create({
      section: section._id, subject: oop._id, status: 'published', createdBy: section._id, author: authorId,
      title: `OOP Lecture ${i + 1}`,
      attachments: [{ url: `https://res.cloudinary.com/oop-${uniq()}.pdf`, originalName: `oop-l${i + 1}.pdf`, mimeType: 'application/pdf', publicId: `nd/oop-${uniq()}` }],
      // staggered createdAt -> the newest-first order is well defined
      createdAt: new Date(Date.now() - (oopFileCount - i) * 3600_000),
    });
  }
  for (let i = 0; i < pfFileCount; i += 1) {
    await Note.create({
      section: section._id, subject: pf._id, status: 'published', createdBy: section._id, author: authorId, title: `PF Handout ${i + 1}`,
      attachments: [{ url: `https://res.cloudinary.com/pf-${uniq()}.pdf`, originalName: `pf-h${i + 1}.pdf`, mimeType: 'application/pdf', publicId: `nd/pf-${uniq()}` }],
    });
  }
  await ChatbotSetting.create({ key: 'global', enabled: true });
  await User.create({ name: 'CR Bhai', email: 'cr@test.local', password: 'Pass123!', role: 'cr', section: section._id, phone: '923004445566' });
}

function groupMsg(text, { author = ASKER } = {}) {
  return {
    event_type: 'message_received', instanceId: 'instance123',
    data: {
      id: 'evt-' + (++n), type: 'chat', fromMe: false,
      chatId: GROUP_ID, from: GROUP_ID, chatType: 'group',
      author: `${author}@c.us`, gatewayPhone: SELF,
      body: `@${SELF} ${text}`,
      time: Math.floor(Date.now() / 1000),
    },
  };
}

const mediaSends = () => waSent.filter((s) => /\/messages\/(document|image|audio|video)$/.test(s.body) || s.kind !== 'text');
const fileBodySends = () => waSent.filter((s) => ['document', 'image', 'audio', 'video'].includes(s.kind));
const dec = (b) => decodeURIComponent(String(b ?? '').replace(/\+/g, ' '));

/* ------------------------------------------------------------------ */
test('CD-A: 13 eligible files -> manifest 13, all 13 sent in order, one job', async () => {
  await seed({ oopFileCount: 13 });
  const oopNotes = await Note.find({ subject: oop._id }).sort({ createdAt: -1, _id: -1 }).lean();
  const picked = pickNotesForDelivery(oopNotes.map((x) => x.title), oopNotes);
  const job = await createNotesDeliveryJob({
    sectionId: section._id, groupId: GROUP_ID, requester: ASKER,
    requesterName: 'Student', msgId: 'msg-cda', question: 'OOP ke saare notes bhej do', picked,
  });
  assert.ok(job, 'job created');
  assert.equal(job.files.length, 13, 'ALL 13 files in the manifest — no truncation');
  assert.deepEqual(job.files.map((f) => f.seq), Array.from({ length: 13 }, (_, i) => i + 1), 'seq 1..13');
  // manifest order = authoritative DB order (newest first)
  assert.deepEqual(
    job.files.map((f) => f.filename),
    oopNotes.flatMap((x) => x.attachments.map((a) => a.originalName)),
    'manifest order matches the deterministic DB order',
  );
  const before = fileBodySends().length;
  const r = await runDeliveryJob(job, GROUP_ID, ASKER);
  assert.equal(r.sent, 13, 'all 13 submitted successfully');
  assert.equal(fileBodySends().length - before, 13, '13 provider media submissions');
  const fresh = await NoteDeliveryJob.findById(job._id);
  assert.equal(fresh.status, 'complete');
  assert.ok(fresh.files.every((f) => f.state === 'sent' && f.providerMsgId), 'per-file provider ids recorded');
  // exactly ONE completion summary for a real batch, and it counts honestly
  const summaries = waSent.filter((s) => dec(s.body).includes('13 me se 13'));
  assert.equal(summaries.length, 1, 'one accurate completion summary');
});

test('CD-B: counts 1, 2, 10, 15 -> complete sets, never truncated', async () => {
  for (const count of [1, 2, 10, 15]) {
    await seed({ oopFileCount: count, pfFileCount: 0 });
    const notes = await Note.find({ subject: oop._id }).sort({ createdAt: -1, _id: -1 }).lean();
    const picked = pickNotesForDelivery(notes.map((x) => x.title), notes);
    const job = await createNotesDeliveryJob({
      sectionId: section._id, groupId: GROUP_ID, requester: ASKER,
      msgId: 'msg-cdb-' + count, question: 'sab bhej do', picked,
    });
    assert.equal(job.files.length, count, `count=${count}: full manifest`);
    const filesBefore = fileBodySends().length;
    const textsBefore = waSent.length;
    const r = await runDeliveryJob(job, GROUP_ID, ASKER);
    assert.equal(r.sent, count, `count=${count}: all sent`);
    assert.equal(fileBodySends().length - filesBefore, count, `count=${count}: all submitted`);
    // batches of 1-2 keep the chat clean (no noise summary); >=3 summarize
    const gotSummary = waSent.slice(textsBefore).some((x) => dec(x.body).includes('files bhej di gayi'));
    assert.equal(gotSummary, count >= 3, `count=${count}: summary only for real batches`);
  }
});

test('CD-C: stable order across repeated runs', async () => {
  await seed({ oopFileCount: 13 });
  const orderOf = async () => {
    const notes = await Note.find({ subject: oop._id }).sort({ createdAt: -1, _id: -1 }).lean();
    const picked = pickNotesForDelivery(notes.map((x) => x.title), notes);
    const job = await createNotesDeliveryJob({
      sectionId: section._id, groupId: GROUP_ID, requester: ASKER,
      msgId: 'msg-cdc-' + uniq(), question: 'sab', picked,
    });
    return job.files.map((f) => f.url);
  };
  const a = await orderOf();
  const b = await orderOf();
  assert.deepEqual(a, b, 'identical order across runs (deterministic sort + tie-breaker)');
  assert.equal(a.length, 13);
});

test('CD-D: mixed file types sent as their real WhatsApp type; missing mime -> document', async () => {
  await seed({ oopFileCount: 3, pfFileCount: 0 });
  await Note.create({
    section: section._id, subject: oop._id, status: 'published', createdBy: section._id, author: authorId, title: 'OOP Diagram',
    attachments: [{ url: `https://res.cloudinary.com/oop-img-${uniq()}.png`, originalName: 'diagram.png', mimeType: 'image/png', publicId: `nd/img-${uniq()}` }],
  });
  await Note.create({
    section: section._id, subject: oop._id, status: 'published', createdBy: section._id, author: authorId, title: 'OOP Mystery File',
    attachments: [{ url: `https://res.cloudinary.com/oop-x-${uniq()}.bin`, originalName: 'data.bin', mimeType: undefined, publicId: `nd/bin-${uniq()}` }],
  });
  const notes = await Note.find({ subject: oop._id }).sort({ createdAt: -1, _id: -1 }).lean();
  const picked = pickNotesForDelivery(notes.map((x) => x.title), notes);
  const job = await createNotesDeliveryJob({
    sectionId: section._id, groupId: GROUP_ID, requester: ASKER, msgId: 'msg-cdd', question: 'sab', picked,
  });
  await runDeliveryJob(job, GROUP_ID, ASKER);
  const kinds = job.files.map((f) => f.mimeType);
  assert.ok(kinds.includes('image/png') && kinds.includes(undefined), 'mixed types present');
  const imgRow = job.files.find((f) => f.mimeType === 'image/png');
  assert.ok(imgRow, 'image file in manifest');
  const imgSend = waSent.find((s) => s.kind === 'image' && dec(s.body).includes(imgRow.url));
  assert.ok(imgSend, 'image sent via the IMAGE endpoint, not document');
  const binRow = job.files.find((f) => !f.mimeType);
  const docSend = waSent.find((s) => s.kind === 'document' && dec(s.body).includes(binRow.url));
  assert.ok(docSend, 'unknown type safely delivered as document');
});

test('CD-E: one file fails mid-batch -> others sent, summary NAMES it, rerun resends only the failed', async () => {
  await seed({ oopFileCount: 5, pfFileCount: 0 });
  // poison the middle file's URL
  await Note.create({
    section: section._id, subject: oop._id, status: 'published', createdBy: section._id, author: authorId, title: 'OOP Poison',
    attachments: [{ url: 'https://res.cloudinary.com/poison.pdf', originalName: 'poison.pdf', mimeType: 'application/pdf', publicId: 'nd/poison' }],
  });
  const notes = await Note.find({ subject: oop._id }).sort({ createdAt: -1, _id: -1 }).lean();
  const poison = notes.find((x) => x.title === 'OOP Poison');
  const rest = notes.filter((x) => x._id !== poison._id);
  const picked = pickNotesForDelivery([poison.title, ...rest.map((x) => x.title)], notes);
  const job = await createNotesDeliveryJob({
    sectionId: section._id, groupId: GROUP_ID, requester: ASKER, msgId: 'msg-cde', question: 'sab', picked,
  });
  const before = fileBodySends().length;
  const r = await runDeliveryJob(job, GROUP_ID, ASKER);
  assert.equal(r.sent, 5, 'the other 5 files all sent');
  assert.equal(r.failed, 1, 'poison failed');
  assert.equal(fileBodySends().length - before, 6, '5 ok + 1 poisoned submission = 6 provider calls');
  const honest = waSent.find((s) => dec(s.body).includes('nahi ja saki') && dec(s.body).includes('poison.pdf'));
  assert.ok(honest, 'summary names the failed file honestly');
  // rerun (sweep-style): sent files are terminal; only the failed file retries
  const before2 = fileBodySends().length;
  const r2 = await runDeliveryJob(job, GROUP_ID, ASKER);
  assert.equal(fileBodySends().length - before2, 1, 'ONLY the failed file retried');
  assert.equal(r2.sent, 5);
  const poisonRow = (await NoteDeliveryJob.findById(job._id)).files.find((f) => f.url.includes('poison'));
  assert.equal(poisonRow.state, 'failed', 'still failed after bounded retry');
});

test('CD-F: duplicate webhook (same msgId) -> ONE job, files sent exactly once', async () => {
  await seed({ oopFileCount: 13, pfFileCount: 0 });
  const notes = await Note.find({ subject: oop._id }).sort({ createdAt: -1, _id: -1 }).lean();
  const picked = pickNotesForDelivery(notes.map((x) => x.title), notes);
  const args = {
    sectionId: section._id, groupId: GROUP_ID, requester: ASKER,
    requesterName: 'Student', msgId: 'msg-cdf', question: 'OOP ke saare notes bhej do', picked,
  };
  const job1 = await createNotesDeliveryJob(args);
  const job2 = await createNotesDeliveryJob(args); // webhook redelivery
  assert.ok(job1);
  assert.equal(job2, null, 'duplicate msgId never creates a second job');
  const before = fileBodySends().length;
  await runDeliveryJob(job1, GROUP_ID, ASKER);
  assert.equal(fileBodySends().length - before, 13, 'each file submitted exactly once');
});

test('CD-G: two workers race the same job -> atomic claims, no double submit', async () => {
  await seed({ oopFileCount: 6, pfFileCount: 0 });
  const notes = await Note.find({ subject: oop._id }).sort({ createdAt: -1, _id: -1 }).lean();
  const picked = pickNotesForDelivery(notes.map((x) => x.title), notes);
  const job = await createNotesDeliveryJob({
    sectionId: section._id, groupId: GROUP_ID, requester: ASKER, msgId: 'msg-cdg', question: 'sab', picked,
  });
  const before = fileBodySends().length;
  const [a, b] = await Promise.all([
    runDeliveryJob(job, GROUP_ID, ASKER),
    runDeliveryJob(job, GROUP_ID, ASKER),
  ]);
  assert.equal(fileBodySends().length - before, 6, 'every file submitted EXACTLY once despite the race');
  const fresh = await NoteDeliveryJob.findById(job._id);
  assert.ok(fresh.files.every((f) => f.state === 'sent'), 'all terminal sent');
  assert.ok(a.sent + b.sent >= 6, 'counts add up without phantom doubles');
});

test('CD-H: worker dies with a claimed file -> never blind-resent; sweep marks unknown + resumes rest', async () => {
  await seed({ oopFileCount: 4, pfFileCount: 0 });
  const notes = await Note.find({ subject: oop._id }).sort({ createdAt: -1, _id: -1 }).lean();
  const picked = pickNotesForDelivery(notes.map((x) => x.title), notes);
  const job = await createNotesDeliveryJob({
    sectionId: section._id, groupId: GROUP_ID, requester: ASKER, msgId: 'msg-cdh', question: 'sab', picked,
  });
  // simulate a crash: one file claimed 'sending', two still pending, one sent
  await NoteDeliveryJob.updateOne(
    { _id: job._id },
    { $set: { 'files.0.state': 'sending', 'files.0.attempts': 1, 'files.1.state': 'sent', status: 'processing', updatedAt: new Date(Date.now() - 10 * 60_000) } },
  );
  const before = fileBodySends().length;
  const r = await runDeliveryJob(job, GROUP_ID, ASKER); // sweep-resume path
  assert.equal(r.sent, 1 + 2, 'sent one recorded + resumed the two pending');
  assert.equal(fileBodySends().length - before, 2, 'claimed file NOT resent; pending two delivered');
  const fresh = await NoteDeliveryJob.findById(job._id);
  const claimed = fresh.files.find((f) => f.seq === 1);
  assert.equal(claimed.state, 'sending', 'uncertain claim untouched — never blind-resent by the runner');
  // the sweep's dead-worker pass flips the stale claim to 'unknown'
  // (re-stamp the staleness: the runner's writes just refreshed updatedAt)
  await NoteDeliveryJob.updateOne(
    { _id: job._id },
    { $set: { updatedAt: new Date(Date.now() - 10 * 60_000) } },
    { timestamps: false }, // re-stamp WITHOUT mongoose bumping updatedAt back to now
  );
  await runNoteDeliverySweep({ staleMs: 0 });
  const after = await NoteDeliveryJob.findById(job._id);
  const flipped = after.files.find((f) => f.seq === 1);
  assert.equal(flipped.state, 'unknown', 'stale claim recorded as uncertain — never auto-resent');
});

test("CD-I: one subject ask never ships another subject's files", async () => {
  await seed({ oopFileCount: 13, pfFileCount: 3 });
  const notes = await Note.find({ subject: oop._id }).sort({ createdAt: -1, _id: -1 }).lean();
  const picked = pickNotesForDelivery(notes.map((x) => x.title), notes);
  const job = await createNotesDeliveryJob({
    sectionId: section._id, groupId: GROUP_ID, requester: ASKER, msgId: 'msg-cdi', question: 'OOP ke notes', picked,
  });
  assert.equal(job.files.length, 13);
  assert.ok(job.files.every((f) => f.title.startsWith('OOP')), 'zero PF files in an OOP delivery');
});

test('CD-J/CD-K: listing asks and jokes never deliver files', async () => {
  await seed({ oopFileCount: 4, pfFileCount: 2 });
  geminiPayload = { reply: JSON.stringify({ reply: 'OOP ke ye notes available hain: sab kuch', send_note_titles: [], intent: 'class_info', needs_cr: false }) };
  waSent.length = 0;
  await handleGroupMessage(groupMsg('OOP ke notes kon se hain?'));
  await handleGroupMessage(groupMsg('yaar mazak ho gaya, paper kal hai 😂'));
  assert.equal(fileBodySends().length, 0, 'listing + casual -> zero file sends');
});

test('CD-L: bounded attempts — a permanently failing file stops after 3 tries', async () => {
  await seed({ oopFileCount: 2, pfFileCount: 0 });
  await Note.create({
    section: section._id, subject: oop._id, status: 'published', createdBy: section._id, author: authorId, title: 'OOP Dead File',
    attachments: [{ url: 'https://res.cloudinary.com/poison.pdf', originalName: 'dead.pdf', mimeType: 'application/pdf', publicId: 'nd/dead' }],
  });
  const notes = await Note.find({ subject: oop._id }).sort({ createdAt: -1, _id: -1 }).lean();
  const picked = pickNotesForDelivery(notes.map((x) => x.title), notes);
  const job = await createNotesDeliveryJob({
    sectionId: section._id, groupId: GROUP_ID, requester: ASKER, msgId: 'msg-cdl', question: 'sab', picked,
  });
  const before = fileBodySends().length;
  await runDeliveryJob(job, GROUP_ID, ASKER);
  await runDeliveryJob(job, GROUP_ID, ASKER);
  await runDeliveryJob(job, GROUP_ID, ASKER);
  await runDeliveryJob(job, GROUP_ID, ASKER);
  const deadSubmit = waSent.filter((s) => s.body.includes('poison.pdf')).length;
  assert.equal(deadSubmit, 3, 'exactly FILE_MAX_ATTEMPTS submissions for a dead file — no retry storm');
  const other = waSent.filter((s) => s.body.includes('oop-l')).length;
  assert.ok(other >= 2, 'healthy files were delivered meanwhile');
  const fresh = await NoteDeliveryJob.findById(job._id);
  const dead = fresh.files.find((f) => f.url.includes('poison'));
  assert.equal(dead.state, 'failed');
  assert.equal(dead.attempts, 3, 'attempts bounded at 3');
});

test('CD-M: full pipeline — "OOP ke saare notes bhej do" delivers 13 of 13 through handleGroupMessage', async () => {
  await seed({ oopFileCount: 13, pfFileCount: 2 });
  waSent.length = 0;
  geminiPayload = { reply: '' }; // LLM offline -> deterministic fallback path
  const handled = await handleGroupMessage(groupMsg('OOP ke saare notes bhej do'));
  assert.equal(handled, true);
  const jobs = await NoteDeliveryJob.find({}).sort({ createdAt: -1 });
  assert.equal(jobs.length, 1, 'exactly one job');
  assert.equal(jobs[0].files.length, 13, 'manifest 13 — the authoritative full set');
  assert.equal(jobs[0].status, 'complete');
  assert.equal(jobs[0].files.filter((f) => f.state === 'sent').length, 13, '13 of 13 sent');
  assert.equal(fileBodySends().length, 13, '13 provider submissions, zero PF leakage');
  const log = await ChatbotLog.findOne({ sentFiles: { $gt: 0 } });
  assert.equal(log.sentFiles, 13, 'audit log counts honestly');
});

test.after(async () => {
  // release every open handle so the child process EXITS (a hanging child
  // would hang the whole `node --test tests/` regression run)
  await mongoose.connection.close().catch(() => {});
  await replset.stop().catch(() => {});
});
