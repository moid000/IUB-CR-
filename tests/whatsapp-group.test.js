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
    if (String(url).includes('/messages/chat')) {
      const params = Object.fromEntries(new URLSearchParams(opts.body));
      sent.push({ url: String(url), params });
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
