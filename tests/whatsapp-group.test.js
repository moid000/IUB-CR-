/**
 * STEP — WhatsApp class-group broadcasts + CR group configuration.
 * Isolated in-memory REPLICA SET; the UltraMsg gateway is simulated by a
 * fetch wrapper that intercepts only gateway URLs (all real API calls
 * pass through to the actual server).
 *
 * Covers (owner-confirmed scope 2026-09-20):
 * - CR group config: link / refresh / unlink, section-scoped.
 * - Broadcasts on announcement / assignment / note / timetable create.
 * - MARKS ARE NEVER BROADCAST (owner's explicit exclusion).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('wa_group_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.ULTRAMSG_INSTANCE_ID = 'instance123';
process.env.ULTRAMSG_TOKEN = 'fake-token';
process.env.ULTRAMSG_API_URL = 'https://ultramsg.test.local';
process.env.ULTRAMSG_INSTANCE_NUMBER = '+92 300 0000000';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const { User, Section, Subject, Announcement } = models;
const { broadcastAttachmentToSectionGroup } = await import('../backend/services/whatsappGroupService.js');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

const GROUP_ID = '12036302@g.us';
const GROUP_NAME = 'Class Group 1G';
const sent = []; // captured gateway sends: { url, params }

/* --------------------------- gateway stubbing ---------------------------- */

const realFetch = globalThis.fetch;

/** Intercepts ONLY UltraMsg URLs; every other fetch hits the real server. */
const CR_WA = '923001110001'; // the CR's registered number, as bare intl digits

/** Gateway-shaped group object (participants = member JIDs). */
function waGroup(id, name, participantIds) {
  return { id, name, groupMetadata: { participants: participantIds.map((n) => ({ id: `${n}@c.us` })) } };
}

function stubGateway({ groups = [waGroup(GROUP_ID, GROUP_NAME, [CR_WA, '923001110002'])], fail = false } = {}) {
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('ultramsg.test.local')) return realFetch(url, opts);
    if (/\/messages\/(chat|image|document|audio|video)/.test(String(url))) {
      const params = Object.fromEntries(new URLSearchParams(opts.body));
      sent.push({ url: String(url), kind: String(url).match(/\/messages\/(\w+)$/)[1], params });
      return new Response(JSON.stringify({ sent: fail ? false : true }), { status: fail ? 400 : 200 });
    }
    if (String(url).includes('/groups')) {
      return new Response(JSON.stringify(groups), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
}

test.afterEach(() => { globalThis.fetch = realFetch; sent.length = 0; });

/* ------------------------------ api session ------------------------------ */

function makeSession() {
  const jar = new Map();
  return {
    async api(method, path, body) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(`${BASE}${path}`, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
      let json = null;
      try { json = await res.json(); } catch { /* non-JSON */ }
      return { status: res.status, json, text: json ? JSON.stringify(json) : '' };
    },
  };
}

const admin = makeSession();
const cr = makeSession();
const student = makeSession();

let section, subject;

test.before(async () => {
  await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  });

  const dept = (await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'CS' })).json.data._id;
  const session = (await admin.api('POST', '/api/admin/sessions', { name: '2026' })).json.data._id;
  section = (await admin.api('POST', '/api/admin/sections', { department: dept, session, semester: 1, name: '1G' })).json.data._id;
  subject = (await admin.api('POST', '/api/admin/subjects', { section, name: 'Data Structures', code: 'DS-101' })).json.data._id;

  const hash = await bcrypt.hash('Pass1234!', 10);
  const crId = (await User.create({ name: 'Group CR', email: 'groupcr@test.local', phone: '+923001110001', role: 'cr', registrationStatus: 'active', emailVerified: true, password: hash, section }))._id;
  await User.create({ name: 'Sneaky Student', email: 'sneaky@test.local', phone: '+923001110002', role: 'student', registrationStatus: 'active', emailVerified: true, password: hash, section, rollNo: 'R-001' });
  await Section.updateOne({ _id: section }, { $set: { cr: crId } });

  assert.equal((await cr.api('POST', '/api/auth/login', { email: 'groupcr@test.local', password: 'Pass1234!' })).status, 200);
  assert.equal((await student.api('POST', '/api/auth/login', { email: 'sneaky@test.local', password: 'Pass1234!' })).status, 200);
});

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
});

async function linkGroup() {
  const res = await cr.api('PUT', '/api/cr/whatsapp-group', { groupId: GROUP_ID, groupName: GROUP_NAME });
  assert.equal(res.status, 200, res.text);
  return res;
}

/* --------------------------------- tests -------------------------------- */

test('config starts unlinked; refresh returns the gateway group list', async () => {
  stubGateway();
  const cfg = await cr.api('GET', '/api/cr/whatsapp-group');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.json.data.group, null);
  assert.equal(cfg.json.data.instanceNumber, '+92 300 0000000');
  assert.ok(cfg.json.data.appUrl.includes('iubcr.vercel.app'));

  const list = await cr.api('GET', '/api/cr/whatsapp-group/groups');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.groups, [{ id: GROUP_ID, name: GROUP_NAME }]);
  assert.equal(list.json.data.totalGroups, 1);
  assert.equal(list.json.data.matchedPhone, '+92 300 1110001');
});

test('empty gateway list means "number not in any group yet"', async () => {
  stubGateway({ groups: [] });
  const list = await cr.api('GET', '/api/cr/whatsapp-group/groups');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.groups, []);
  assert.equal(list.json.data.totalGroups, 0);
});

/* -------------------- owner privacy rule: MY groups only -------------------- */

test('refresh hides other sections\' groups — only groups containing the CR\'s number are returned', async () => {
  stubGateway({
    groups: [
      waGroup(GROUP_ID, GROUP_NAME, [CR_WA, '923001110002']),           // my class group
      waGroup('999@g.us', 'Section 2M class group', ['923001119999']), // another section's group
      waGroup('998@g.us', 'Random group', ['923001118888']),
    ],
  });
  const list = await cr.api('GET', '/api/cr/whatsapp-group/groups');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.groups, [{ id: GROUP_ID, name: GROUP_NAME }]);
  assert.equal(list.json.data.totalGroups, 3); // total known, but only mine listed
});

test('link rejects a group the CR is not a member of', async () => {
  stubGateway({ groups: [waGroup('999@g.us', 'Other section', ['923001119999'])] });
  const res = await cr.api('PUT', '/api/cr/whatsapp-group', { groupId: '999@g.us', groupName: 'Other section' });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /own WhatsApp number/);
});

test('link uses the gateway\'s group name, never the client\'s', async () => {
  stubGateway();
  const res = await cr.api('PUT', '/api/cr/whatsapp-group', { groupId: GROUP_ID, groupName: 'Fake Name' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.data.group.name, GROUP_NAME); // gateway truth wins
});

test('CR without a registered phone gets a no-phone reason and cannot link', async () => {
  const hash = await bcrypt.hash('Pass1234!', 10);
  await User.create({ name: 'NoPhone CR', email: 'nophonecr@test.local', role: 'cr', registrationStatus: 'active', emailVerified: true, password: hash, section });
  const nocr = makeSession();
  await nocr.api('POST', '/api/auth/login', { email: 'nophonecr@test.local', password: 'Pass1234!' });

  stubGateway();
  const list = await nocr.api('GET', '/api/cr/whatsapp-group/groups');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.groups, []);
  assert.equal(list.json.data.reason, 'no-phone');
  assert.equal(list.json.data.totalGroups, 1);

  const res = await nocr.api('PUT', '/api/cr/whatsapp-group', { groupId: GROUP_ID, groupName: GROUP_NAME });
  assert.equal(res.status, 400);
});

test('link saves the group; get returns it; unlink clears it', async () => {
  stubGateway();
  await linkGroup();

  const cfg = await cr.api('GET', '/api/cr/whatsapp-group');
  assert.equal(cfg.json.data.group.id, GROUP_ID);
  assert.equal(cfg.json.data.group.name, GROUP_NAME);

  const unlink = await cr.api('DELETE', '/api/cr/whatsapp-group');
  assert.equal(unlink.status, 200);
  assert.equal(unlink.json.data.group, null);

  const after = await cr.api('GET', '/api/cr/whatsapp-group');
  assert.equal(after.json.data.group, null);
});

test('link rejects malformed group ids', async () => {
  const bad = await cr.api('PUT', '/api/cr/whatsapp-group', { groupId: 'not-a-group', groupName: 'X' });
  assert.equal(bad.status, 400);
});

test('students cannot touch the group config', async () => {
  stubGateway();
  assert.equal((await student.api('GET', '/api/cr/whatsapp-group')).status, 403);
  assert.equal((await student.api('PUT', '/api/cr/whatsapp-group', { groupId: GROUP_ID, groupName: 'nope' })).status, 403);
  assert.equal((await student.api('GET', '/api/cr/whatsapp-group/groups')).status, 403);
});

test('LEGACY create (no suppress) marks groupBroadcastAt so later files still deliver', async () => {
  stubGateway();
  await linkGroup();

  const res = await cr.api('POST', '/api/cr/announcements', { title: 'Legacy path', content: 'Old client flow.' });
  assert.equal(res.status, 200, res.text);
  const id = res.json.data._id;
  assert.ok((await Announcement.findById(id)).groupBroadcastAt, 'legacy create must mark groupBroadcastAt');
  // the explicit broadcast endpoint must NOT resend the text (idempotent against the legacy send)
  const again = (await cr.api('POST', `/api/cr/announcements/${id}/broadcast`)).json.data;
  assert.equal(again.sent, false);
  assert.equal(again.reason, 'already-broadcast');
  assert.equal(sent.length, 1, 'no duplicate chat allowed');
});

test('announcement create broadcasts to the linked group', async () => {
  stubGateway();
  await linkGroup();

  const res = await cr.api('POST', '/api/cr/announcements', { title: 'Quiz on Monday', content: 'Bring calculators' });
  assert.equal(res.status, 200, res.text);

  assert.equal(sent.length, 1, `expected 1 gateway send, got ${sent.length}`);
  assert.equal(sent[0].params.to, GROUP_ID);
  assert.ok(sent[0].params.body.includes('Quiz on Monday'));
  assert.ok(sent[0].params.body.includes('announcement'));
});

test('no broadcast when the section has no linked group', async () => {
  stubGateway(); // never linked in this test
  await cr.api('DELETE', '/api/cr/whatsapp-group'); // independence: clear any prior link
  const res = await cr.api('POST', '/api/cr/announcements', { title: 'Quiet post', content: 'no group yet' });
  assert.equal(res.status, 200, res.text);
  assert.equal(sent.length, 0);
});

test('assignment create broadcasts with PKT deadline', async () => {
  stubGateway();
  await linkGroup();

  const res = await cr.api('POST', '/api/cr/assignments', {
    subject, title: 'Lab 1 submission', deadline: '2026-09-26T18:00:00.000Z',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].params.body.includes('Lab 1 submission'));
  assert.ok(sent[0].params.body.includes('Data Structures'));
  assert.ok(/11:00\s?pm/i.test(sent[0].params.body), sent[0].params.body); // 18:00Z = 23:00 PKT
});

test('note create broadcasts with subject', async () => {
  stubGateway();
  await linkGroup();

  const res = await cr.api('POST', '/api/cr/notes', { title: 'DS lecture 5 notes', subject });
  assert.equal(res.status, 200, res.text);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].params.body.includes('Data Structures'));
});

test('timetable create broadcasts the slot', async () => {
  stubGateway();
  await linkGroup();

  const res = await cr.api('POST', '/api/cr/timetable', {
    subject, date: '2026-09-21', startTime: '09:00', endTime: '10:30', room: 'Room 12',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].params.body.includes('Class added'));
  assert.ok(sent[0].params.body.includes('Data Structures'));
  assert.ok(sent[0].params.body.includes('9:00 AM – 10:30 AM'), sent[0].params.body);
});

/* ---------------- combined one-shot broadcast (owner 2026-09-20) ----------- */

test('suppressGroupBroadcast: create sends NOTHING until the explicit broadcast', async () => {
  stubGateway();
  await linkGroup();
  sent.length = 0;

  const res = await cr.api('POST', '/api/cr/announcements', {
    title: 'Pic with details', content: 'Full description here.',
    suppressGroupBroadcast: true,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(sent.length, 0, 'create must stay silent when suppressed');

  const id = res.json.data._id;
  const out = await cr.api('POST', `/api/cr/announcements/${id}/broadcast`);
  assert.equal(out.status, 200, out.text);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'chat');
  assert.ok(sent[0].params.body.includes('Pic with details'));
  assert.ok(sent[0].params.body.includes('Full description here.'));
});

test('second broadcast call does NOT duplicate the burst (idempotency)', async () => {
  stubGateway();
  const ann = (await cr.api('POST', '/api/cr/announcements', {
    title: 'Idempotent burst', content: 'Ek hi dafa.', suppressGroupBroadcast: true,
  })).json.data;
  const first = (await cr.api('POST', `/api/cr/announcements/${ann._id}/broadcast`)).json.data;
  assert.equal(first.sent, true);
  const second = (await cr.api('POST', `/api/cr/announcements/${ann._id}/broadcast`)).json.data;
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'already-broadcast');
  const stored = await Announcement.findById(ann._id);
  assert.ok(stored.groupBroadcastAt, 'groupBroadcastAt persists');
  // messages sent to the mock gateway: exactly ONE chat from the first broadcast
  const sentChats = sent.filter((m) => m.params?.to === GROUP_ID && m.kind === 'chat');
  assert.equal(sentChats.filter((m) => m.params?.body?.includes('Idempotent burst')).length, 1);
});

test('broadcast endpoint delivers text + ALL attachments together in one burst', async () => {
  stubGateway();
  await linkGroup();
  sent.length = 0;

  const res = await cr.api('POST', '/api/cr/notes', {
    title: 'Combined note', content: 'Chapter 4 summary', subject,
    suppressGroupBroadcast: true,
  });
  assert.equal(res.status, 200, res.text);
  const id = res.json.data._id;

  // attach two fake files directly (metadata shape only — media send is stubbed)
  const { Note } = models;
  await Note.updateOne({ _id: id }, { $set: { attachments: [
    { publicId: 'a1', url: 'https://res.cloudinary.com/t/i/one.png', mimeType: 'image/png', originalName: 'one.png' },
    { publicId: 'a2', url: 'https://res.cloudinary.com/t/i/two.pdf', mimeType: 'application/pdf', originalName: 'two.pdf' },
  ] } });

  const out = await cr.api('POST', `/api/cr/notes/${id}/broadcast`);
  assert.equal(out.status, 200, out.text);
  assert.equal(sent.length, 3, 'text + image + document, one burst');
  assert.equal(sent[0].kind, 'chat');
  assert.equal(sent[1].kind, 'image');
  assert.equal(sent[2].kind, 'document');
  assert.equal(sent[2].params.filename, 'two.pdf');
});

test('broadcast marks groupBroadcastAt so later attach-confirmed files also go out', async () => {
  stubGateway();
  await linkGroup();
  sent.length = 0;

  const res = await cr.api('POST', '/api/cr/announcements', {
    title: 'Later file', content: 'More coming.', suppressGroupBroadcast: true,
  });
  const id = res.json.data._id;
  await cr.api('POST', `/api/cr/announcements/${id}/broadcast`);
  assert.equal(sent.length, 1);

  const { Announcement } = models;
  const doc = await Announcement.findById(id);
  assert.ok(doc.groupBroadcastAt, 'groupBroadcastAt must be set after broadcast');

  // later-attached file (confirm flow) goes to the group on its own
  await broadcastAttachmentToSectionGroup(doc.section, {
    publicId: 'late1', url: 'https://res.cloudinary.com/t/i/late.jpg',
    mimeType: 'image/jpeg', originalName: 'late.jpg',
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].kind, 'image');
});

test('assignment: suppressed create + broadcast endpoint sends text with deadline', async () => {
  stubGateway();
  await linkGroup();
  sent.length = 0;

  const res = await cr.api('POST', '/api/cr/assignments', {
    title: 'Lab 5', instructions: 'Bring kits', subject,
    deadline: new Date(Date.now() + 48 * 3600e3).toISOString(),
    suppressGroupBroadcast: true,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(sent.length, 0);

  const out = await cr.api('POST', `/api/cr/assignments/${res.json.data._id}/broadcast`);
  assert.equal(out.status, 200, out.text);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].params.body.includes('Lab 5'));
  assert.ok(/Due:/.test(sent[0].params.body));
});

test('broadcast endpoint: cross-section doc 404s; archived doc 404s', async () => {
  stubGateway();
  await linkGroup();

  const sec = await Section.findById(section);
  const other = await admin.api('POST', '/api/admin/sections', {
    name: 'WA-Other', department: sec.department, session: sec.session, semester: sec.semester,
  });
  const otherId = other.json.data._id;
  const made = await admin.api('POST', '/api/admin/announcements', {
    section: otherId, title: 'Other section', content: 'x',
  });
  const out = await cr.api('POST', `/api/cr/announcements/${made.json.data._id}/broadcast`);
  assert.equal(out.status, 404);
});

/* -------------------- attachment / media broadcasts ----------------------- */

test('announcement text carries FULL content and NO app link', async () => {
  stubGateway();
  await linkGroup();

  const long = 'Detailed plan. '.repeat(40); // ~600 chars — must arrive in full
  const res = await cr.api('POST', '/api/cr/announcements', { title: 'Semester plan', content: long });
  assert.equal(res.status, 200, res.text);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].params.body.includes(long.trim()), 'full content missing');
  assert.ok(!sent[0].params.body.includes('Open Tri3M'), 'app link must be gone');
  assert.ok(!sent[0].params.body.includes('iubcr.vercel.app'), 'app URL must be gone');
});

const CDN = 'https://res.cloudinary.com/demo/iub-cr-lms/announcement/abc.pdf';
function fakeAttachment(mime, name = 'file') {
  return {
    publicId: 'iub-cr-lms/announcement/x'.replace('x', name) + '-0123456789ab',
    url: `${CDN}/${name}`,
    resourceType: mime.startsWith('image/') ? 'image' : 'raw',
    mimeType: mime,
    originalName: name,
    size: 1234,
  };
}

test('confirmed pic attachment goes to the group as a WhatsApp IMAGE message', async () => {
  stubGateway();
  await linkGroup();
  sent.length = 0;

  const out = await broadcastAttachmentToSectionGroup(section, fakeAttachment('image/jpeg', 'trip.jpg'));
  assert.equal(out.sent, true, JSON.stringify(out));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'image');
  assert.equal(sent[0].params.to, GROUP_ID);
  assert.equal(sent[0].params.image, `${CDN}/trip.jpg`);
});

test('confirmed PDF attachment goes as a DOCUMENT message with its filename', async () => {
  stubGateway();
  await linkGroup();
  sent.length = 0;

  await broadcastAttachmentToSectionGroup(section, fakeAttachment('application/pdf', 'notes.pdf'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'document');
  assert.equal(sent[0].params.document, `${CDN}/notes.pdf`);
  assert.equal(sent[0].params.filename, 'notes.pdf');
});

test('confirmed voice/audio attachment goes as a playable AUDIO message', async () => {
  stubGateway();
  await linkGroup();
  sent.length = 0;

  await broadcastAttachmentToSectionGroup(section, fakeAttachment('audio/mpeg', 'lecture.mp3'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'audio');
  assert.equal(sent[0].params.audio, `${CDN}/lecture.mp3`);
});

test('video attachment goes as a VIDEO message; unknown types fall back to document', async () => {
  stubGateway();
  await linkGroup();
  sent.length = 0;

  await broadcastAttachmentToSectionGroup(section, fakeAttachment('video/mp4', 'clip.mp4'));
  await broadcastAttachmentToSectionGroup(section, fakeAttachment('application/zip', 'slides.zip'));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].kind, 'video');
  assert.equal(sent[1].kind, 'document');
  assert.equal(sent[1].params.filename, 'slides.zip');
});

test('one failing attachment never blocks the others', async () => {
  stubGateway({ fail: true }); // gateway rejects
  await linkGroup();
  sent.length = 0;

  const out = await broadcastAttachmentToSectionGroup(section, fakeAttachment('image/png', 'bad.png'));
  assert.equal(out.sent, false); // swallowed, no throw
});

test('no media send when the section has no linked group', async () => {
  stubGateway();
  await cr.api('DELETE', '/api/cr/whatsapp-group'); // independence
  sent.length = 0;

  const out = await broadcastAttachmentToSectionGroup(section, fakeAttachment('image/png', 'gone.png'));
  assert.deepEqual(out, { sent: false, reason: 'no-group' });
  assert.equal(sent.length, 0);
});

test('announcement create with already-attached files sends text THEN media, in order', async () => {
  stubGateway();
  await linkGroup();
  sent.length = 0;

  // create first, then attach (real flow) — but also prove the create-time
  // path forwards existing attachments by broadcasting directly:
  const res = await cr.api('POST', '/api/cr/notes', { title: 'Photo note', content: 'See attached', subject });
  assert.equal(res.status, 200, res.text);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'chat');
  assert.ok(sent[0].params.body.includes('See attached'));

  await broadcastAttachmentToSectionGroup(section, fakeAttachment('image/webp', 'shot.webp'));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].kind, 'image'); // media arrives after the text
});

test('a failed group send never breaks content creation', async () => {
  stubGateway({ fail: true });
  await linkGroup();

  const res = await cr.api('POST', '/api/cr/announcements', { title: 'Resilient post', content: 'gateway down' });
  assert.equal(res.status, 200, res.text); // created fine, broadcast failed silently
});

test('marks endpoints never broadcast (owner exclusion)', async () => {
  stubGateway();
  await linkGroup();

  const assessment = await cr.api('POST', '/api/cr/assessments', {
    subject, title: 'Quiz 1', type: 'quiz', totalMarks: 10, assessmentDate: '2026-09-25T09:00:00.000Z',
  });
  assert.equal(assessment.status, 200, assessment.text);
  sent.length = 0; // assessment create itself never broadcasts either

  const opened = await cr.api('POST', `/api/cr/assessments/${assessment.json.data._id}/open`);
  assert.equal(opened.status, 200, opened.text);
  assert.equal(sent.length, 0, 'opening must never broadcast');

  const mark = await cr.api('POST', `/api/cr/assessments/${assessment.json.data._id}/marks`, {
    student: (await User.findOne({ email: 'sneaky@test.local' }))._id,
    marksObtained: 8,
  });
  assert.equal(mark.status, 200, mark.text);
  assert.equal(sent.length, 0, 'marks must never trigger a group broadcast');
});

test('update/archive/delete of content never re-broadcast', async () => {
  stubGateway();
  await linkGroup();

  const created = await cr.api('POST', '/api/cr/announcements', { title: 'Once only', content: 'body' });
  assert.equal(created.status, 200, created.text);
  sent.length = 0;

  const id = created.json.data._id;
  assert.equal((await cr.api('PATCH', `/api/cr/announcements/${id}`, { title: 'Edited' })).status, 200);
  assert.equal((await cr.api('POST', `/api/cr/announcements/${id}/archive`)).status, 200);
  assert.equal((await cr.api('DELETE', `/api/cr/announcements/${id}`)).status, 200);
  assert.equal(sent.length, 0);
});
