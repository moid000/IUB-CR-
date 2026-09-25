/**
 * Danger-zone wipe tests — POST /api/admin/wipe-all (PROTECTED).
 * Covers: auth guard (401/403), confirm phrase guard (400),
 * DUAL-VERIFICATION guard (403 without/with wrong codes — nothing deleted),
 * administration profile CRUD + validation, code request flow (masked
 * response, single-use, attempt burn), full cascade (every content
 * collection + CR/student accounts emptied, admin survives, audit written),
 * idempotency on an already-empty database.
 *
 * Outbound email (Brevo) + WhatsApp (UltraMsg) calls are intercepted and
 * the delivered codes are captured so the happy-path wipe can be verified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('wipe_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.BREVO_SENDER_EMAIL = 'tri3m@test.local';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud-xyz';
process.env.CLOUDINARY_API_KEY = '123456789012345';
process.env.CLOUDINARY_API_SECRET = 'fake-api-secret-abcdef';
process.env.ULTRAMSG_INSTANCE_ID = 'instance-fake';
process.env.ULTRAMSG_TOKEN = 'fake-token';

// Intercept OUTBOUND delivery calls (Brevo + UltraMsg) and capture the codes;
// local API calls go through untouched.
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('brevo.com') || u.includes('ultramsg.com')) {
    outbound.push({ url: u, opts });
    return new Response(JSON.stringify({ success: true, sent: 'ok' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(url, opts);
};

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');

const {
  User, Department, AcademicSession, Section, Subject, Announcement, Note,
  Assignment, Submission, Timetable, Assessment, Mark, Notification, AuditLog, Otp,
  WipeVerification,
} = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

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
      return { status: res.status, json };
    },
  };
}

const must = async (resP, label) => {
  const res = await resP;
  if (res?.status !== 200) throw new Error(`FIXTURE ${label} -> ${res?.status}: ${JSON.stringify(res?.json)}`);
  return res.json.data._id;
};

const admin = makeSession();
const cr = makeSession();
const student = makeSession();

/** Requests a fresh code pair (bypassing the 60s cooldown via backdating) and captures both codes. */
async function freshCodes() {
  // Direct driver update — createdAt is schema-immutable, a $set via mongoose is silently dropped
  await WipeVerification.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 120_000) } });
  outbound.length = 0;
  const res = await admin.api('POST', '/api/admin/wipe-all/request-codes', {});
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const emailBody = outbound.find((o) => o.url.includes('brevo.com'))?.opts.body ?? '';
  const waBody = new URLSearchParams(String(outbound.find((o) => o.url.includes('ultramsg.com'))?.opts.body ?? '')).get('body') ?? '';
  const emailCode = String(emailBody).match(/verification code is:\s*(\d{6})/)?.[1];
  const waCode = String(waBody).match(/Your code is:\s*\*?(\d{6})\*?/)?.[1];
  assert.ok(emailCode, 'email code captured');
  assert.ok(waCode, 'whatsapp code captured');
  return { emailCode, waCode };
}

test('fixtures: full hierarchy + content', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  const dept = (await must(admin.api('POST', '/api/admin/departments', { name: 'AI', code: 'AI' }), 'dept'));
  const sess = (await must(admin.api('POST', '/api/admin/sessions', { name: 'Fall 2026' }), 'sess'));
  const sec = (await must(admin.api('POST', '/api/admin/sections', { department: dept, session: sess, semester: 1, name: '1M' }), 'sec'));

  const hash = await bcrypt.hash('Pass1234!', 10);
  const crId = await User.create({
    name: 'Demo CR', email: 'wipe-cr@test.local', phone: '+923001110011',
    role: 'cr', registrationStatus: 'active', emailVerified: true, password: hash, section: sec,
  }).then((u) => u._id);
  await User.create({
    name: 'Demo Student', email: 'wipe-s@test.local', phone: '+923001110022',
    role: 'student', registrationStatus: 'active', emailVerified: true, password: hash,
    section: sec, rollNo: 'S-001',
  });
  await Section.updateOne({ _id: sec }, { $set: { cr: crId } });

  const sub = (await must(admin.api('POST', '/api/admin/subjects', { section: sec, name: 'Intro to AI', code: 'AI-101' }), 'sub'));

  assert.equal((await cr.api('POST', '/api/auth/login', { email: 'wipe-cr@test.local', password: 'Pass1234!' })).status, 200);
  assert.equal((await student.api('POST', '/api/auth/login', { email: 'wipe-s@test.local', password: 'Pass1234!' })).status, 200);

  await must(cr.api('POST', '/api/cr/announcements', { title: 'Welcome', content: 'First post.' }), 'ann');
  await must(cr.api('POST', '/api/cr/notes', { title: 'Ch 1', content: 'Read it.', subject: sub }), 'note');
  const asg = (await cr.api('POST', '/api/cr/assignments', {
    subject: sub, title: 'Task 1', instructions: 'Do it.',
    deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  })).json.data._id;
  await must(cr.api('POST', '/api/cr/timetable', { subject: sub, date: '2026-10-05', startTime: '10:00', endTime: '11:00' }), 'slot');
  await must(cr.api('POST', '/api/cr/assessments', {
    subject: sub, title: 'Quiz 1', type: 'quiz', totalMarks: 20,
    assessmentDate: '2026-09-20T09:00:00.000Z',
  }), 'quiz');
  assert.equal((await student.api('POST', `/api/student/assignments/${asg}/submission`, { textAnswer: 'My solution.' })).status, 200);
});

test('W1. wipe requires authentication — 401 without a session', async () => {
  const anon = makeSession();
  const res = await anon.api('POST', '/api/admin/wipe-all', { confirm: 'DELETE' });
  assert.equal(res.status, 401);
});

test('W2. wipe + code request are admin-only — CR gets 403 and data survives', async () => {
  assert.equal((await cr.api('POST', '/api/admin/wipe-all', { confirm: 'DELETE' })).status, 403);
  assert.equal((await cr.api('POST', '/api/admin/wipe-all/request-codes', {})).status, 403);
  assert.ok((await User.countDocuments({ role: 'cr' })) === 1);
  assert.ok((await Department.countDocuments()) === 1);
});

test('W3. wrong/missing confirm phrase → 400, nothing deleted', async () => {
  assert.equal((await admin.api('POST', '/api/admin/wipe-all')).status, 400);
  assert.equal((await admin.api('POST', '/api/admin/wipe-all', { confirm: 'delete' })).status, 400);
  assert.equal((await admin.api('POST', '/api/admin/wipe-all', { confirm: 'RESET' })).status, 400);
  assert.equal((await Department.countDocuments()), 1, 'departments untouched');
  assert.equal((await User.countDocuments({ role: 'student' })), 1, 'students untouched');
});

test('W3b. administration profile: set up, read back, validate', async () => {
  // Not configured yet
  let res = await admin.api('GET', '/api/admin/administration/profile');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.configured, false);

  // Invalid inputs rejected
  assert.equal((await admin.api('PUT', '/api/admin/administration/profile', { email: 'not-an-email', whatsapp: '+92 301 9670950' })).status, 400);
  assert.equal((await admin.api('PUT', '/api/admin/administration/profile', { email: 'chief@test.local', whatsapp: '123' })).status, 400);

  // Valid profile
  res = await admin.api('PUT', '/api/admin/administration/profile', {
    name: 'Administration', email: 'chief@test.local', whatsapp: '+92 301 9670950',
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.email, 'chief@test.local');
  assert.equal(res.json.data.whatsapp, '923019670950', 'normalized to international digits');

  res = await admin.api('GET', '/api/admin/administration/profile');
  assert.equal(res.json.data.configured, true);
  assert.equal(res.json.data.profile.email, 'chief@test.local');
  assert.equal(res.json.data.profile.whatsapp, '923019670950');

  // CR/GR cannot read or write the profile
  assert.equal((await cr.api('GET', '/api/admin/administration/profile')).status, 403);
  assert.equal((await cr.api('PUT', '/api/admin/administration/profile', { email: 'x@test.local', whatsapp: '+92 301 9670950' })).status, 403);
});

test('W3c. code request delivers email + WhatsApp codes, response is masked', async () => {
  outbound.length = 0;
  const res = await admin.api('POST', '/api/admin/wipe-all/request-codes', {});
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.expiresInSeconds, 900);
  assert.ok(res.json.data.sentTo.email.includes('***'), 'email masked');
  assert.ok(res.json.data.sentTo.whatsapp.endsWith('0950'), 'phone tail visible only');
  assert.ok(!JSON.stringify(res.json).match(/\d{6}/), 'no code leaked in the response');

  const brevo = outbound.find((o) => o.url.includes('brevo.com'));
  const wa = outbound.find((o) => o.url.includes('ultramsg.com'));
  assert.ok(brevo, 'email sent');
  assert.ok(wa, 'whatsapp sent');
  assert.ok(String(brevo.opts.body).includes('chief@test.local'), 'code emailed to profile email');
  assert.ok(String(wa.opts.body).includes('to=923019670950'), 'code sent to profile whatsapp');

  // Cooldown
  const again = await admin.api('POST', '/api/admin/wipe-all/request-codes', {});
  assert.equal(again.status, 429);
});

test('W3d. wipe WITHOUT codes → 403, nothing deleted (the core protection)', async () => {
  await freshCodes();
  const res = await admin.api('POST', '/api/admin/wipe-all', { confirm: 'DELETE' });
  assert.equal(res.status, 403);
  assert.equal(await Department.countDocuments(), 1, 'departments untouched');
  assert.equal(await User.countDocuments({ role: 'student' }), 1, 'students untouched');
  assert.equal(await WipeVerification.countDocuments(), 1, 'pair NOT consumed by a missing-code call');

  const partial = await admin.api('POST', '/api/admin/wipe-all', { confirm: 'DELETE', emailCode: '000000' });
  assert.equal(partial.status, 403, 'one code alone is never enough');
  assert.equal(await Department.countDocuments(), 1);
});

test('W3e. WRONG codes → 403; 5 wrong attempts burn the pair', async () => {
  await freshCodes();
  for (let i = 0; i < 5; i += 1) {
    const res = await admin.api('POST', '/api/admin/wipe-all', {
      confirm: 'DELETE', emailCode: '000000', waCode: '999999',
    });
    assert.equal(res.status, 403);
  }
  assert.equal(await WipeVerification.countDocuments(), 0, 'pair burned after 5 wrong attempts');
  assert.equal(await Department.countDocuments(), 1, 'still nothing deleted');
});

test('W4. confirmed wipe WITH both codes empties everything except admins + audit logs', async () => {
  const { emailCode, waCode } = await freshCodes();
  const res = await admin.api('POST', '/api/admin/wipe-all', {
    confirm: 'DELETE', emailCode, waCode,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.success, true);
  assert.ok(res.json.data.deleted, 'deleted counts returned');
  assert.deepEqual(res.json.data.kept, ['admin accounts', 'audit logs']);
  assert.equal(res.json.data.deleted.pendingWipeCodes, 0, 'pair already consumed before deletion ran (single use)');
  assert.equal(await WipeVerification.countDocuments(), 0, 'no verification pairs remain');

  const zero = async (model, label) => assert.equal(await model.countDocuments({}), 0, `${label} emptied`);
  await zero(Department, 'departments');
  await zero(AcademicSession, 'sessions');
  await zero(Section, 'sections');
  await zero(Subject, 'subjects');
  await zero(Announcement, 'announcements');
  await zero(Note, 'notes');
  await zero(Assignment, 'assignments');
  await zero(Submission, 'submissions');
  await zero(Timetable, 'timetable');
  await zero(Assessment, 'assessments');
  await zero(Mark, 'marks');
  await zero(Notification, 'notifications');
  await zero(Otp, 'otps');

  const users = await User.find();
  assert.equal(users.length, 1, 'only the admin account survives');
  assert.equal(users[0].role, 'admin');

  const audit = await AuditLog.findOne({ action: 'system.wipe' });
  assert.ok(audit, 'wipe is audited');

  // Codes are single-use: the same pair can never wipe again
  const replay = await admin.api('POST', '/api/admin/wipe-all', {
    confirm: 'DELETE', emailCode, waCode,
  });
  assert.equal(replay.status, 403, 'consumed pair cannot be replayed');

  // Administration profile SURVIVES the wipe (it is admin configuration)
  const profile = await admin.api('GET', '/api/admin/administration/profile');
  assert.equal(profile.json.data.configured, true);
  assert.equal(profile.json.data.profile.email, 'chief@test.local');
});

test('W5. after the wipe the admin still logs in, CR and students cannot', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', {
    email: 'admin@test.local', password: 'AdminPass123!456',
  })).status, 200);

  const gone = makeSession();
  assert.equal((await gone.api('POST', '/api/auth/login', { email: 'wipe-cr@test.local', password: 'Pass1234!' })).status, 401);
  assert.equal((await gone.api('POST', '/api/auth/login', { email: 'wipe-s@test.local', password: 'Pass1234!' })).status, 401);
});

test('W6. wiping an already-empty system succeeds with fresh codes', async () => {
  const { emailCode, waCode } = await freshCodes();
  const res = await admin.api('POST', '/api/admin/wipe-all', {
    confirm: 'DELETE', emailCode, waCode,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.deleted.departments, 0);
  assert.equal(res.json.data.deleted.crAndStudentAccounts, 0);
});

test('cleanup', async () => {
  await mongoose.disconnect();
  await mongod.stop();
  server.close();
});
