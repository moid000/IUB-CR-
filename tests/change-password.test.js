/**
 * STEP 18 tests — POST /api/auth/change-password (self-service rotation).
 * Requires re-authentication with the CURRENT password, enforces the standard
 * password policy, writes ONLY a bcrypt hash, keeps the session intact, and
 * never echoes old or new values in any response or log.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('chpwd_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { User, AuditLog } = models;
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
      return { status: res.status, json, text: json ? JSON.stringify(json) : '' };
    },
  };
}

const stu = makeSession();
const admin = makeSession();
let stuId;

const OLD = 'Pass1234!';
const NEW = 'Br@ndNew2026!';

test('fixtures: active student', async () => {
  const hash = await bcrypt.hash(OLD, 10);
  stuId = (await User.create({
    name: 'Student One', email: 'cp-s1@test.local', role: 'student',
    registrationStatus: 'active', emailVerified: true, password: hash,
  }))._id;
  assert.equal((await stu.api('POST', '/api/auth/login', { email: 'cp-s1@test.local', password: OLD })).status, 200);
  assert.equal((await admin.api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'AdminPass123!456' })).status, 200);
});

test('C1. unauthenticated → 401', async () => {
  assert.equal((await makeSession().api('POST', '/api/auth/change-password', {
    currentPassword: OLD, newPassword: NEW,
  })).status, 401);
});

test('C2. wrong current password → 401, password unchanged', async () => {
  const r = await stu.api('POST', '/api/auth/change-password', {
    currentPassword: 'WrongPass9!', newPassword: NEW,
  });
  assert.equal(r.status, 401);
  const doc = await User.findById(stuId).select('+password');
  assert.ok(await bcrypt.compare(OLD, doc.password), 'original password still valid');
});

test('C3. weak new password → 400 (policy enforced)', async () => {
  assert.equal((await stu.api('POST', '/api/auth/change-password', { currentPassword: OLD, newPassword: 'short' })).status, 400);
  assert.equal((await stu.api('POST', '/api/auth/change-password', { currentPassword: OLD, newPassword: 'nodigits!!A' })).status, 400);
  assert.equal((await stu.api('POST', '/api/auth/change-password', { currentPassword: OLD, newPassword: undefined })).status, 400);
});

test('C4. new password identical to current → 400', async () => {
  assert.equal((await stu.api('POST', '/api/auth/change-password', { currentPassword: OLD, newPassword: OLD })).status, 400);
});

test('C5. success: hash rotated, old password dead, session intact, no echo', async () => {
  const r = await stu.api('POST', '/api/auth/change-password', { currentPassword: OLD, newPassword: NEW });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.changed, true);
  assert.ok(!r.text.includes(NEW), 'new password never echoed');
  assert.ok(!r.text.includes(OLD), 'old password never echoed');

  // session survives — no re-login needed
  assert.equal((await stu.api('GET', '/api/auth/me')).status, 200);

  // old password rejected, new accepted
  assert.equal((await makeSession().api('POST', '/api/auth/login', { email: 'cp-s1@test.local', password: OLD })).status, 401);
  assert.equal((await makeSession().api('POST', '/api/auth/login', { email: 'cp-s1@test.local', password: NEW })).status, 200);

  // stored ONLY as a bcrypt hash
  const doc = await User.findById(stuId).select('+password');
  assert.ok(doc.password.startsWith('$2'), 'bcrypt hash stored');
  assert.ok(!doc.password.includes(NEW), 'never plaintext');
  assert.ok(await bcrypt.compare(NEW, doc.password));
});

test('C6. audit event exists and contains no password material', async () => {
  const ev = await AuditLog.findOne({ action: 'auth.change_password' }).lean();
  assert.ok(ev, 'audit trail exists');
  assert.equal(String(ev.actor), String(stuId));
  const evText = JSON.stringify(ev);
  assert.ok(!evText.includes(NEW) && !evText.includes(OLD), 'audit never contains password material');
});

test('C7. change-password works for the ADMIN bootstrap account too', async () => {
  const r = await admin.api('POST', '/api/auth/change-password', {
    currentPassword: 'AdminPass123!456', newPassword: 'R0tated!2026#X',
  });
  assert.equal(r.status, 200);
  // old bootstrap password dead
  assert.equal((await makeSession().api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'AdminPass123!456' })).status, 401);
  assert.equal((await makeSession().api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'R0tated!2026#X' })).status, 200);
});

test('C8. second rotation back works (chain of rotations)', async () => {
  const s = makeSession();
  assert.equal((await s.api('POST', '/api/auth/login', { email: 'cp-s1@test.local', password: NEW })).status, 200);
  assert.equal((await s.api('POST', '/api/auth/change-password', { currentPassword: NEW, newPassword: 'Th1rd!Pass#9' })).status, 200);
  assert.equal((await s.api('GET', '/api/auth/me')).status, 200);
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
