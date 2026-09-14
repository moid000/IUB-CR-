/**
 * Auth foundation + Admin management tests (STEP 3A).
 * Runs against an in-memory MongoDB REPLICA SET (transactions required).
 * Production Atlas is NEVER touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

// ---- replica-set in-memory MongoDB (needed for transactions) ----
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });

process.env.MONGODB_URI = mongod.getUri('auth_admin_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { runAdminBootstrap } = await import('../backend/services/adminBootstrap.js');
const bcrypt = (await import('bcryptjs')).default;

const { User, Department, AcademicSession, Section, AuditLog } = models;

await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(
  Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init())
);

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- HTTP helper with per-session cookie jars ----
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
        const [pair, ...attrs] = raw.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (value === '' || attrs.some((a) => a.trim().toLowerCase().startsWith('max-age=0'))) {
          jar.delete(name);
        } else {
          jar.set(name, value);
        }
      }
      let json = null;
      try { json = await res.json(); } catch { /* non-JSON */ }
      return { status: res.status, json, setCookies: res.headers.getSetCookie?.() ?? [] };
    },
    hasCookie: (name) => jar.has(name),
  };
}

const oid = () => new mongoose.Types.ObjectId();

async function hash(plain) { return bcrypt.hash(plain, 10); }

// ---------- 1-3. Admin bootstrap ----------
test('bootstrap creates exactly one admin', async () => {
  const result = await runAdminBootstrap();
  assert.equal(result.created, true);
  const admins = await User.countDocuments({ role: 'admin' });
  assert.equal(admins, 1);
  const admin = await User.findOne({ role: 'admin' }).select('+password');
  assert.ok(admin.password && admin.password.startsWith('$2'), 'password stored as bcrypt hash');
  assert.equal(admin.registrationStatus, 'active');
  assert.equal(admin.emailVerified, true);
  assert.equal(admin.section, null);
  assert.equal(admin.createdBy, null);
});

test('bootstrap is idempotent — no duplicate, no password reset', async () => {
  const before = await User.findOne({ email: 'admin@test.local' }).select('+password');
  const result = await runAdminBootstrap();
  assert.equal(result.existed, true);
  const admins = await User.countDocuments({ role: 'admin' });
  assert.equal(admins, 1);
  const after = await User.findOne({ email: 'admin@test.local' }).select('+password');
  assert.equal(after.password, before.password, 'hash must not be reset');
  assert.equal(after.lastLoginAt?.toString?.() ?? null, before.lastLoginAt?.toString?.() ?? null);
});

test('bootstrap FAILS SAFELY when ADMIN_EMAIL belongs to a non-admin', async () => {
  await User.create({ name: 'Existing Student', email: 'conflict@test.local', role: 'student' });
  await assert.rejects(
    () => runAdminBootstrap({ email: 'conflict@test.local', password: 'Whatever123!' }),
    /conflict/i
  );
  const still = await User.findOne({ email: 'conflict@test.local' });
  assert.equal(still.role, 'student', 'account must NOT be converted to admin');
});

// ---------- admin/session fixtures ----------
// NOTE: the admin session logs in during test 4 — bootstrap tests (1-3) must
// complete before any HTTP request, since the first request also runs the
// cached app bootstrap.
const admin = makeSession();
let crSession, studentSession;

// ---------- 4, 8, 22. Login basics ----------
test('admin login succeeds with httpOnly cookie and safe payload', async () => {
  // fresh call to inspect raw set-cookie
  const fresh = await admin.api('POST', '/api/auth/login', {
    email: 'Admin@Test.Local', password: 'AdminPass123!456',
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.success, true);
  const cookieHeader = fresh.setCookies.find((c) => c.startsWith('iub_auth='));
  assert.ok(cookieHeader, 'auth cookie set');
  assert.ok(/httponly/i.test(cookieHeader), 'cookie is httpOnly');
  assert.ok(/samesite=lax/i.test(cookieHeader), 'cookie SameSite=Lax');
  const userJson = JSON.stringify(fresh.json);
  assert.ok(!userJson.includes('password'), 'no password field in login response');
  assert.ok(!userJson.includes('$2'), 'no password hash in login response');
  assert.ok(!userJson.includes('iub_auth') || !fresh.json.token, 'no token in JSON body');
});

test('wrong password fails with a generic error', async () => {
  const s = makeSession();
  const res = await s.api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'WrongPass999!' });
  assert.equal(res.status, 401);
  assert.equal(res.json.message, 'Invalid email or password');
  assert.ok(!s.hasCookie('iub_auth'));
});

test('unknown email fails with the same generic error (no existence leak)', async () => {
  const s = makeSession();
  const res = await s.api('POST', '/api/auth/login', { email: 'ghost@test.local', password: 'Whatever123' });
  assert.equal(res.status, 401);
  assert.equal(res.json.message, 'Invalid email or password');
});

// ---------- 6, 7. pending/suspended ----------
test('pending CR cannot login', async () => {
  await User.create({
    name: 'Pending CR', email: 'pendingcr@test.local', role: 'cr',
    registrationStatus: 'pending', password: await hash('Pending123!'),
  });
  const s = makeSession();
  const res = await s.api('POST', '/api/auth/login', { email: 'pendingcr@test.local', password: 'Pending123!' });
  assert.equal(res.status, 403);
  assert.equal(res.json.message, 'Account not activated yet');
});

test('suspended account cannot login', async () => {
  await User.create({
    name: 'Suspended CR', email: 'suspended@test.local', role: 'cr',
    registrationStatus: 'suspended', password: await hash('Suspend123!'),
  });
  const s = makeSession();
  const res = await s.api('POST', '/api/auth/login', { email: 'suspended@test.local', password: 'Suspend123!' });
  assert.equal(res.status, 403);
  assert.equal(res.json.message, 'Account suspended');
});

// ---------- 9. /auth/me ----------
test('/auth/me returns safe fields only', async () => {
  const res = await admin.api('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  const u = res.json.user;
  assert.equal(u.email, 'admin@test.local');
  assert.equal(u.role, 'admin');
  assert.deepEqual(
    Object.keys(u).sort(),
    ['activationAt', 'email', 'emailVerified', 'id', 'lastLoginAt', 'name',
     'phone', 'registrationStatus', 'role', 'rollNo', 'section'].sort()
  );
  const raw = JSON.stringify(res.json);
  assert.ok(!raw.includes('password'), 'no password key');
  assert.ok(!raw.includes('createdBy'), 'no audit internals');
});

test('/auth/me rejects unauthenticated requests', async () => {
  const s = makeSession();
  const res = await s.api('GET', '/api/auth/me');
  assert.equal(res.status, 401);
});

// ---------- 10. logout ----------
test('logout clears the auth cookie', async () => {
  const res = await admin.api('POST', '/api/auth/logout');
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  const cleared = res.setCookies.find((c) => c.startsWith('iub_auth='));
  assert.ok(cleared, 'cookie cleared');
  // cookie jar removed it → subsequent me is unauthorized
  const meRes = await admin.api('GET', '/api/auth/me');
  assert.equal(meRes.status, 401);
  // re-login for later tests
  await admin.api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'AdminPass123!456' });
});

// ---------- 11. throttle ----------
test('login throttle activates after 5 failures within 15 minutes', async () => {
  const s = makeSession();
  const email = 'throttle-victim@test.local';
  // create a real user so the password path is exercised, then fail 5 times
  await User.create({
    name: 'Throttle User', email, role: 'cr', registrationStatus: 'active',
    password: await hash('Real1234!'),
  });
  for (let i = 0; i < 5; i++) {
    const r = await s.api('POST', '/api/auth/login', { email, password: `BadPass${i}!x` });
    assert.equal(r.status, 401);
  }
  const blocked = await s.api('POST', '/api/auth/login', { email, password: 'Real1234!' });
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.message, /too many failed attempts/i);
  // correct credentials are also throttled (no lock bypass)
  const blockedCorrect = await s.api('POST', '/api/auth/login', { email, password: 'Real1234!' });
  assert.equal(blockedCorrect.status, 429);
});

// ---------- fixtures: dept / session / section / users ----------
let deptId, sessionId, sectionA, sectionB;

test('admin creates department and academic session fixtures', async () => {
  const d = await admin.api('POST', '/api/admin/departments', { name: 'Computer Science', code: 'cs' });
  assert.equal(d.status, 200);
  deptId = d.json.data._id;
  const s = await admin.api('POST', '/api/admin/sessions', { name: '2026–27' });
  assert.equal(s.status, 200);
  sessionId = s.json.data._id;
  const sec = await admin.api('POST', '/api/admin/sections', {
    department: deptId, session: sessionId, semester: 3, name: '3m',
  });
  assert.equal(sec.status, 200);
  sectionA = sec.json.data._id;
  const sec2 = await admin.api('POST', '/api/admin/sections', {
    department: deptId, session: sessionId, semester: 4, name: '4M',
  });
  sectionB = sec2.json.data._id;
});

// ---------- 12, 13. role enforcement ----------
test('CR cannot access admin endpoints', async () => {
  await User.create({
    name: 'Active CR', email: 'activecr@test.local', role: 'cr',
    registrationStatus: 'active', password: await hash('Active123!'), section: sectionB,
  });
  crSession = makeSession();
  const login = await crSession.api('POST', '/api/auth/login', { email: 'activecr@test.local', password: 'Active123!' });
  assert.equal(login.status, 200);
  const res = await crSession.api('GET', '/api/admin/departments');
  assert.equal(res.status, 403);
});

test('student cannot access admin endpoints', async () => {
  await User.create({
    name: 'Active Student', email: 'activestudent@test.local', role: 'student',
    registrationStatus: 'active', password: await hash('Student123!'), section: sectionA, rollNo: 'R-001',
  });
  studentSession = makeSession();
  const login = await studentSession.api('POST', '/api/auth/login', { email: 'activestudent@test.local', password: 'Student123!' });
  assert.equal(login.status, 200);
  const res = await studentSession.api('POST', '/api/admin/departments', { name: 'Hack Dept', code: 'HK' });
  assert.equal(res.status, 403);
  const resList = await studentSession.api('GET', '/api/admin/sections');
  assert.equal(resList.status, 403);
});

test('unauthenticated request cannot access admin endpoints', async () => {
  const s = makeSession();
  const res = await s.api('GET', '/api/admin/departments');
  assert.equal(res.status, 401);
});

// ---------- 14-17. duplicates ----------
test('duplicate department is rejected', async () => {
  const res = await admin.api('POST', '/api/admin/departments', { name: 'computer science', code: 'CS' });
  assert.equal(res.status, 409);
});

test('duplicate session name is rejected', async () => {
  const res = await admin.api('POST', '/api/admin/sessions', { name: '2026–27', status: 'archived' });
  assert.equal(res.status, 409);
});

test('two active sessions are rejected', async () => {
  const res = await admin.api('POST', '/api/admin/sessions', { name: '2027–28', status: 'active' });
  assert.equal(res.status, 409);
});

test('duplicate section is rejected', async () => {
  const res = await admin.api('POST', '/api/admin/sections', {
    department: deptId, session: sessionId, semester: 3, name: '3M',
  });
  assert.equal(res.status, 409);
});

// ---------- 18-20. CR invariants + transactions ----------
let crA, crB;

test('CR pre-creation (option A: creates section transactionally)', async () => {
  const res = await admin.api('POST', '/api/admin/crs', {
    name: 'First CR', email: 'firstcr@test.local', phone: '+923001234567',
    department: deptId, session: sessionId, semester: 5, sectionName: '5M',
  });
  assert.equal(res.status, 200);
  crA = res.json.data;
  assert.equal(crA.role, 'cr');
  assert.equal(crA.registrationStatus, 'pending');
  // DB-level consistency (test 20)
  const userDoc = await User.findOne({ email: 'firstcr@test.local' }).select('+password');
  const sectionDoc = await Section.findOne({ name: '5M' });
  assert.equal(sectionDoc.cr.toString(), userDoc._id.toString());
  assert.equal(userDoc.section.toString(), sectionDoc._id.toString());
  assert.equal(userDoc.password, null);
  assert.equal(userDoc.emailVerified, false);
});

test('two CRs cannot occupy one section (no silent overwrite)', async () => {
  // pre-create second CR with an existing-section (option B) — section B already has no CR? section B has activeCR as member but no cr
  const res = await admin.api('POST', '/api/admin/crs', {
    name: 'Second CR', email: 'secondcr@test.local', phone: '+923007654321',
    sectionId: sectionB,
  });
  assert.equal(res.status, 200);
  crB = res.json.data;
  // third CR tries to take section B which now has a CR
  const conflict = await admin.api('POST', '/api/admin/crs', {
    name: 'Third CR', email: 'thirdcr@test.local', phone: '+923001112223',
    sectionId: sectionB,
  });
  assert.equal(conflict.status, 409);
  // email that already exists is rejected too
  const dupEmail = await admin.api('POST', '/api/admin/crs', {
    name: 'Dup', email: 'firstcr@test.local', sectionId: sectionA,
  });
  assert.equal(dupEmail.status, 409);
});

test('CR cannot be assigned to two sections', async () => {
  // crA already belongs to section 5M — try assigning to another section
  const res = await admin.api('POST', `/api/admin/sections/${sectionA}/cr`, { userId: crA.id ?? crA._id });
  assert.equal(res.status, 409);
  assert.match(res.json.message, /already belongs/i);
});

test('assign-cr rejects non-CR users', async () => {
  const student = await User.findOne({ email: 'activestudent@test.local' });
  const res = await admin.api('POST', `/api/admin/sections/${sectionA}/cr`, { userId: String(student._id) });
  assert.equal(res.status, 400);
});

// ---------- 21. pastMembers protection ----------
test('pastMembers cannot be manipulated through update payloads', async () => {
  const res = await admin.api('PATCH', `/api/admin/sections/${sectionA}`, {
    pastMembers: [oid(), oid()],
    status: 'archived',        // protected field
    cr: oid(),                 // protected field
    department: oid(),        // protected field
    name: '3X',                // allowed field
  });
  assert.equal(res.status, 200);
  const doc = await Section.findById(sectionA);
  assert.deepEqual(doc.pastMembers, [], 'pastMembers unchanged');
  assert.equal(doc.status, 'active', 'status unchanged');
  assert.equal(doc.cr, null, 'cr unchanged');
  assert.equal(doc.name, '3X', 'allowed field updated');
});

// ---------- section archive with CR ----------
test('archiving a section clears the CR link transactionally, keeps the account', async () => {
  const sectionDoc = await Section.findOne({ name: '5M' });
  const crUserId = sectionDoc.cr;
  const res = await admin.api('POST', `/api/admin/sections/${sectionDoc._id}/archive`);
  assert.equal(res.status, 200);
  const after = await Section.findById(sectionDoc._id);
  assert.equal(after.status, 'archived');
  assert.equal(after.cr, null);
  const crUser = await User.findById(crUserId);
  assert.ok(crUser, 'CR account NOT deleted');
  assert.equal(crUser.section, null, 'CR becomes sectionless');
  assert.equal(crUser.registrationStatus, 'pending', 'account status untouched');
});

// ---------- department archive guard ----------
test('archiving a department with active sections is rejected', async () => {
  const res = await admin.api('POST', `/api/admin/departments/${deptId}/archive`);
  assert.equal(res.status, 400);
  assert.match(res.json.message, /active sections/i);
});

// ---------- validation ----------
test('invalid ObjectIds return clean 400 errors', async () => {
  const res = await admin.api('GET', '/api/admin/sections/not-an-id');
  assert.equal(res.status, 400);
  assert.equal(res.json.message, 'Invalid section id');
});

test('invalid semester and email return clean 400 errors', async () => {
  const res = await admin.api('POST', '/api/admin/sections', {
    department: deptId, session: sessionId, semester: 12, name: '9M',
  });
  assert.equal(res.status, 400);
  const badEmail = await admin.api('POST', '/api/admin/crs', {
    name: 'Bad', email: 'not-an-email', sectionId: sectionB,
  });
  assert.equal(badEmail.status, 400);
});

test('session update cannot create a second active session', async () => {
  const other = await admin.api('POST', '/api/admin/sessions', { name: '2025–26', status: 'archived' });
  assert.equal(other.status, 200);
  const res = await admin.api('PATCH', `/api/admin/sessions/${other.json.data._id}`, { status: 'active' });
  assert.equal(res.status, 409);
});

// ---------- 22. no password hash anywhere ----------
test('no password hash appears in normal API responses', async () => {
  const meRes = await admin.api('GET', '/api/auth/me');
  const listRes = await admin.api('GET', '/api/admin/sections');
  const sessionList = await admin.api('GET', '/api/admin/sessions');
  for (const r of [meRes, listRes, sessionList]) {
    const raw = JSON.stringify(r.json);
    assert.ok(!raw.includes('$2a$') && !raw.includes('$2b$'), 'no bcrypt hash leaked');
  }
});

test('audit events were recorded for auth flows', async () => {
  const successes = await AuditLog.countDocuments({ action: 'auth.login.success' });
  assert.ok(successes >= 3);
  const fails = await AuditLog.countDocuments({ action: 'auth.login.fail' });
  assert.ok(fails >= 5);
  const logouts = await AuditLog.countDocuments({ action: 'auth.logout' });
  assert.ok(logouts >= 1);
  const precreate = await AuditLog.countDocuments({ action: 'user.cr.precreate' });
  assert.ok(precreate >= 1);
  // no plaintext password ever persisted
  const bad = await AuditLog.countDocuments({ $or: [{ 'after.password': { $exists: true } }, { 'before.password': { $exists: true } }] });
  assert.equal(bad, 0);
});

/* ---- Step 14: admin CR directory (read-only list) ---- */
test('admin CR directory: pagination, search, section filter, no security fields', async () => {
  const res = await admin.api('GET', '/api/admin/crs?limit=5');
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.ok(Array.isArray(res.json.data));
  assert.equal(res.json.pagination.page, 1);
  assert.equal(res.json.pagination.limit, 5);
  for (const cr of res.json.data) {
    assert.ok(!('password' in cr), 'password must never be serialized');
    assert.ok(!('passwordHash' in cr));
    assert.ok(!('otpHash' in cr));
    assert.equal(cr.role, undefined, 'role is implicit in the directory');
    assert.ok(['pending', 'active', 'suspended'].includes(cr.registrationStatus));
  }
});

test('admin CR directory: search and section filter behave', async () => {
  const sections = await admin.api('GET', '/api/admin/sections?status=active');
  const withCr = (sections.json.data ?? []).find((s) => s.cr);
  if (withCr) {
    const res = await admin.api('GET', `/api/admin/crs?section=${withCr._id}`);
    assert.equal(res.status, 200);
    for (const cr of res.json.data) {
      assert.equal(String(cr.section?._id ?? cr.section), String(withCr._id));
    }
  }
  const none = await admin.api('GET', '/api/admin/crs?search=zz-no-such-cr-xyz');
  assert.equal(none.status, 200);
  assert.equal(none.json.data.length, 0);
});

test('admin CR directory is admin-only', async () => {
  const res = await admin.api('GET', '/api/admin/crs');
  assert.equal(res.status, 200);
  // unauthenticated
  const anon = makeSession();
  const unauth = await anon.api('GET', '/api/admin/crs');
  assert.equal(unauth.status, 401);
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
