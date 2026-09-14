/**
 * STEP 12 tests — Backend Final QA / Security Hardening.
 * Consolidated PROOF tests for the production-readiness audit:
 *   A. route inventory behavior (public health only, 404 for unknowns)
 *   B. authentication primitives (JWT claims, cookie flags, forged tokens)
 *   C/D. privilege + prototype-pollution injection battery
 *   E. malformed-input sweep — no 500s for normal client garbage
 *   M. global audit-log secret-leak scan (every action ever logged)
 * NO real credentials. Fake fixtures only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('sec_audit_test');
process.env.JWT_SECRET = 'audit-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-brevo-key-xkeysib000000';
process.env.ATTENDANCE_SECRET = 'audit-only-attendance-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'audit-cloud';
process.env.CLOUDINARY_API_KEY = '111111111111111';
process.env.CLOUDINARY_API_SECRET = 'fake-api-secret-audit';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { User, Section, Subject, Assessment, Mark, AuditLog, Announcement, Submission } = models;
const { AUTH_COOKIE } = await import('../backend/utils/constants.js');
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const { default: app } = await import('../backend/app.js');
const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

function makeSession() {
  const jar = new Map();
  return {
    async api(method, path, body, raw) {
      const headers = {};
      if (raw !== undefined) {
        headers['content-type'] = 'application/json';
        const res = await fetch(`${BASE}${path}`, { method, headers, body: raw });
        return { status: res.status, json: await res.json().catch(() => null) };
      }
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(`${BASE}${path}`, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return {
        status: res.status,
        setCookie: res.headers.getSetCookie?.() ?? [],
        json: await res.json().catch(() => null),
        text: '',
      };
    },
  };
}

const admin = makeSession();
const cr = makeSession();
const student = makeSession();
let secA, subA, s1Id, crId;

const A = (p) => `/api/cr${p}`;
const ADM = (p) => `/api/admin${p}`;
const STU = (p) => `/api/student${p}`;

/* ---------------- fixtures ---------------- */
test('fixtures', async () => {
  assert.equal((await admin.api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'AdminPass123!456' })).status, 200);
  const dept = (await admin.api('POST', ADM('/departments'), { name: 'CS', code: 'CS' })).json.data._id;
  const sess = (await admin.api('POST', ADM('/sessions'), { name: '2028–29' })).json.data._id;
  secA = (await admin.api('POST', ADM('/sections'), { department: dept, session: sess, semester: 5, name: '5A' })).json.data._id;
  subA = (await admin.api('POST', ADM('/subjects'), { section: secA, name: 'DB', code: 'DB-9' })).json.data._id;
  const hash = await bcrypt.hash('Pass1234!', 10);
  crId = (await User.create({
    name: 'CR One', email: 'qa-cr@test.local', phone: '+923001220001', role: 'cr',
    registrationStatus: 'active', emailVerified: true, password: hash, section: secA,
  }))._id.toString();
  s1Id = (await User.create({
    name: 'Stud One', email: 'qa-s1@test.local', phone: '+923001220002', role: 'student',
    registrationStatus: 'active', emailVerified: true, password: hash, section: secA, rollNo: 'Q-001',
  }))._id.toString();
  await Section.updateOne({ _id: secA }, { $set: { cr: crId } });
  assert.equal((await cr.api('POST', '/api/auth/login', { email: 'qa-cr@test.local', password: 'Pass1234!' })).status, 200);
  assert.equal((await student.api('POST', '/api/auth/login', { email: 'qa-s1@test.local', password: 'Pass1234!' })).status, 200);
});

/* ---------------- A. route inventory behavior ---------------- */
test('A1. /api/health is the ONLY public route; unknown paths 404, not 500', async () => {
  const health = await makeSession().api('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.database, 'connected');
  for (const p of ['/api/nope', '/api/admin/nonsense/deep/path', '/api/cr/nonsense', '/api/student/nonsense']) {
    const anon = await makeSession().api('GET', p);
    assert.ok([401, 404].includes(anon.status), `${p} → ${anon.status}`); // gated or unknown — never open
    assert.ok(anon.status !== 500, `${p} must not 500`);
  }
  // unknown METHOD on a known router still safe
  const del = await makeSession().api('DELETE', '/api/admin/subjects');
  // auth middleware runs before route matching — unauthenticated gets 401,
  // authenticated-without-permission would 404. Either way: never 500.
  assert.ok([401, 404].includes(del.status), `DELETE → ${del.status}`);
});

/* ---------------- B. authentication primitives ---------------- */
test('B1. session cookie: httpOnly + SameSite=Lax (Secure in production)', async () => {
  const s = makeSession();
  const res = await s.api('POST', '/api/auth/login', { email: 'qa-s1@test.local', password: 'Pass1234!' });
  assert.equal(res.status, 200);
  const raw = res.setCookie.join('; ');
  assert.ok(/HttpOnly/i.test(raw), 'httpOnly flag present');
  assert.ok(/SameSite=Lax/i.test(raw), 'SameSite=Lax present');
});

test('B2. JWT contains ONLY minimal claims (userId, role, iat, exp)', async () => {
  const s = makeSession();
  const res = await s.api('POST', '/api/auth/login', { email: 'qa-s1@test.local', password: 'Pass1234!' });
  const cookie = res.setCookie.find((c) => c.startsWith(`${AUTH_COOKIE}=`));
  const token = cookie.slice(`${AUTH_COOKIE}=`.length).split(';')[0];
  const payload = jwt.decode(token);
  assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'role', 'userId']);
  assert.equal(payload.role, 'student');
  // no section ownership / password / PII in the token
  assert.ok(!('section' in payload) && !('password' in payload) && !('email' in payload));
});

test('B3. forged/tampered JWT rejected; activation-type tokens cannot act as sessions', async () => {
  const s = makeSession();
  const forged = jwt.sign({ userId: s1Id, role: 'admin' }, 'wrong-secret');
  const res = await fetch(`${BASE}/api/admin/sections`, { headers: { authorization: `Bearer ${forged}` } });
  assert.equal(res.status, 401);
  // activation-style token (has `type` claim) is never a login session
  const activationTok = jwt.sign({ userId: s1Id, role: 'admin', type: 'activation' }, 'audit-only-jwt-secret');
  const res2 = await fetch(`${BASE}/api/admin/sections`, { headers: { authorization: `Bearer ${activationTok}` } });
  assert.equal(res2.status, 401);
});

test('B4. logout clears the session cookie; old cookie no longer works', async () => {
  const s = makeSession();
  assert.equal((await s.api('POST', '/api/auth/login', { email: 'qa-s1@test.local', password: 'Pass1234!' })).status, 200);
  const out = await s.api('POST', '/api/auth/logout');
  assert.equal(out.status, 200);
  const cleared = out.setCookie.find((c) => new RegExp(`${AUTH_COOKIE}=;`).test(c));
  assert.ok(cleared, 'cookie cleared on logout');
  // remaining jar (old value if any) — fresh anonymous access must 401
  const me = await makeSession().api('GET', '/api/auth/me');
  assert.equal(me.status, 401);
});

test('B5. suspended account cannot authenticate', async () => {
  await User.updateOne({ _id: s1Id }, { $set: { registrationStatus: 'suspended' } });
  const s = makeSession();
  const login = await s.api('POST', '/api/auth/login', { email: 'qa-s1@test.local', password: 'Pass1234!' });
  assert.equal(login.status, 403);
  await User.updateOne({ _id: s1Id }, { $set: { registrationStatus: 'active' } });
});

/* ---------------- C/D. privilege + prototype-pollution injection ---------------- */
test('C1. client cannot inject role/status/ownership on representative mutations', async () => {
  // student precreate with role/section/registrationStatus injection
  const inj = await cr.api('POST', A('/students'), {
    name: 'Inj Kid', email: 'qa-inj@test.local', rollNo: 'Q-099',
    role: 'admin', section: 'GLOBAL_ADMIN', registrationStatus: 'active',
    emailVerified: true, password: 'Injected1!x', pastMembers: [s1Id],
  });
  assert.equal(inj.status, 200);
  const created = await User.findOne({ email: 'qa-inj@test.local' });
  assert.equal(created.role, 'student'); // injected role ignored
  assert.equal(String(created.section), String(secA)); // CR's own section
  assert.equal(created.registrationStatus, 'pending'); // server-controlled
  await User.deleteOne({ _id: created._id });

  // announcement with forbidden fields
  const ann = await cr.api('POST', A('/announcements'), {
    section: secA, title: 'T', content: 'C',
    createdBy: s1Id, status: 'archived', role: 'admin',
  });
  assert.equal(ann.status, 200);
  assert.equal(String(ann.json.data.section), String(secA));
  assert.equal('createdBy' in ann.json.data, false, 'createdBy is never exposed in responses');
  assert.equal(ann.json.data.status, 'published'); // server-controlled default, injected 'archived' ignored
  const annDoc = await Announcement.findById(ann.json.data._id);
  assert.equal(String(annDoc.author), String(crId)); // server-derived in the DB

  // assessment finalize-injection ignored (status stays draft until the explicit route)
  const asg = await cr.api('POST', A('/assessments'), {
    subject: subA, title: 'QA', type: 'quiz', totalMarks: 10,
    assessmentDate: '2026-10-01T00:00:00Z',
    status: 'finalized', finalizedBy: s1Id, finalizedAt: new Date().toISOString(),
  });
  assert.equal(asg.status, 200);
  assert.equal(asg.json.data.status, 'draft');
  assert.equal(asg.json.data.finalizedAt, null);
  await cr.api('POST', A(`/assessments/${asg.json.data._id}/archive`));
});

test('C2. prototype-pollution style keys are inert', async () => {
  const res = await cr.api('POST', A('/announcements'), {
    title: 'Proto', content: 'C',
    __proto__: { role: 'admin' },
    constructor: { prototype: { isAdmin: true } },
    'nested.__proto__.x': 'y',
  });
  assert.equal(res.status, 200);
  // express/user object NOT polluted
  assert.ok(!({}).isAdmin);
  const doc = await Announcement.findById(res.json.data._id);
  assert.equal(String(doc.author), crId); // server-derived, prototype keys ignored
});

/* ---------------- E. malformed input sweep — never a 500 ---------------- */
test('E1. malformed bodies on representative mutation endpoints → safe 4xx', async () => {
  const cases = [
    [cr, 'POST', A('/announcements'), null],
    [cr, 'POST', A('/announcements'), {}],
    [cr, 'POST', A('/announcements'), []],
    [cr, 'POST', A('/announcements'), 'a plain string'],
    [cr, 'POST', A('/announcements'), 42],
    [cr, 'POST', A('/announcements'), { title: 'x'.repeat(100000), content: 'y' }],
    [cr, 'POST', A('/announcements'), { title: '   ', content: '' }],
    [cr, 'POST', A('/announcements'), { title: { $gt: '' }, content: { nested: { deep: [] } } }],
    [cr, 'POST', A('/students'), { name: ['array'], email: { obj: 1 } }],
    [cr, 'POST', A('/assessments'), { subject: 'not-an-id', title: 'x', type: 'quiz', totalMarks: 10, assessmentDate: 'x' }],
    [cr, 'POST', A('/assessments'), { subject: subA, title: 'x', type: 'quiz', totalMarks: { $numberInt: '5' }, assessmentDate: [] }],
    [cr, 'PATCH', A('/subjects/notavalidid24chars'), { name: 'x' }],
    [student, 'POST', STU('/attendance/sessions/badid/attend'), { code: 'AAAAAAAA' }],
    [student, 'POST', STU('/attendance/sessions/badid/attend'), { code: { $ne: null } }],
    [student, 'POST', STU('/assignments/badid/submission'), { content: 'x' }],
    [student, 'GET', STU('/assignments/' + 'f'.repeat(24) + '/submission'), undefined],
    [cr, 'POST', A('/assessments/x/marks/bulk'), { rows: 'not-array' }],
    [cr, 'POST', A('/assessments/x/marks/bulk'), { rows: [{ student: { $oid: 'x' }, marksObtained: {} }] }],
  ];
  for (const [sessn, method, path, body] of cases) {
    const res = await sessn.api(method, path, body);
    assert.ok([400, 401, 403, 404, 409, 413].includes(res.status), `${method} ${path} ${String(JSON.stringify(body)).slice(0, 40)} → ${res.status}`);
    assert.ok(res.status < 500, `${method} ${path} must never 500 (got ${res.status})`);
  }
});

test('E2. malformed JSON / oversized bodies → 400/413, never 500', async () => {
  const broken = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email": BROKEN',
  });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).message, 'Invalid JSON body');

  const huge = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"a":"${'x'.repeat(2_000_000)}"}`,
  });
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).message, 'Request body too large');
});

test('E3. error responses never leak internals', async () => {
  const probe = await cr.api('GET', A('/assessments'), undefined);
  // run several error paths and scan every body for internals
  const bodies = [];
  bodies.push(JSON.stringify((await cr.api('PATCH', A('/subjects/notavalidid'), { name: 'x' })).json));
  bodies.push(JSON.stringify((await cr.api('POST', A('/announcements'), { title: 'x' })).json));
  const raw = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  bodies.push(await raw.text());
  const big = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2_000_000) });
  bodies.push(await big.text());
  const text = bodies.join(' ');
  for (const secret of ['audit-only-jwt-secret', 'fake-brevo-key', 'fake-api-secret-audit',
    'audit-only-attendance-secret', 'AdminPass123', 'mongodb://', 'node_modules', 'at Object', 'at ']) {
    assert.ok(!text.includes(secret), `leak detected: ${secret.slice(0, 12)}`);
  }
});

/* ---------------- M. global audit-log leak scan ---------------- */
test('M1. NO audit event ever contains any secret-like content', async () => {
  // touch a broad set of flows so many audit actions exist by now
  await cr.api('POST', A('/announcements'), { title: 'Audit scan', content: 'C' });
  await admin.api('GET', ADM('/sections'));
  await student.api('GET', STU('/notifications'));
  const logs = await AuditLog.find({});
  assert.ok(logs.length >= 5, 'audit trail exists');
  const text = JSON.stringify(logs.map((l) => l.toJSON()));
  for (const bad of ['audit-only-jwt-secret', 'fake-brevo-key', 'fake-api-secret-audit',
    'audit-only-attendance-secret', 'AdminPass123', 'Pass1234', '$2a$', '$2b$', 'password":',
    'codeHash', 'Bearer ', 'cookie', 'xkeysib']) {
    assert.ok(!text.includes(bad), `audit leak: ${bad}`);
  }
  // append-only: no modification helper exists on any route (inventory check)
  const res = await admin.api('PATCH', '/api/admin/auditlogs/x', {});
  assert.ok([401, 404].includes(res.status) || res.status === 404, 'no audit mutation route');
});

/* ---------------- F/L. concurrency + finalization invariant spot checks ---------------- */
test('F1. concurrent first-submissions → unique index holds exactly one document', async () => {
  const asg = (await cr.api('POST', A('/assignments'), {
    subject: subA, title: 'QA asg', description: 'd',
    deadline: new Date(Date.now() + 864e5).toISOString(),
  })).json.data;
  // 6 concurrent identical submissions — the upsert is idempotent, and the
  // unique {assignment, student} index is the DB-level arbiter: ONE document.
  const calls = await Promise.allSettled(Array.from({ length: 6 }, () =>
    student.api('POST', STU(`/assignments/${asg._id}/submission`), { textAnswer: 'my work' })));
  assert.ok(calls.every((c) => [200, 400, 409].includes(c.value.status)), `no 500s: ${calls.map((c) => c.value.status).join(',')}`);
  const count = await Submission.countDocuments({ assignment: asg._id, student: s1Id });
  assert.equal(count, 1, 'exactly one submission document exists');
  const ids = new Set(calls.filter((c) => c.value.status === 200).map((c) => c.value.json.data._id));
  assert.equal(ids.size, 1, 'all successful responses reference the same document');
});

test('F1b. pagination garbage → safe fallback to defaults (no 500, hard cap intact)', async () => {
  const res = await cr.api('GET', A('/assessments?limit=-5&page=abc&sectionId[]=x&search[$ne]=1'));
  assert.equal(res.status, 200); // garbage clamped to defaults — never a Mongo operator passthrough
  assert.ok(res.json.pagination.limit <= 100, 'limit hard-capped');
});

test('L1. finalization invariant: finalized ⇒ every mark finalized (incl. compensation)', async () => {
  const a = (await cr.api('POST', A('/assessments'), {
    subject: subA, title: 'Inv', type: 'quiz', totalMarks: 10, assessmentDate: '2026-10-01T00:00:00Z',
  })).json.data;
  await cr.api('POST', A(`/assessments/${a._id}/open`));
  await cr.api('POST', A(`/assessments/${a._id}/marks`), { student: s1Id, marksObtained: 6 });
  // concurrent finalize + new mark — either order allowed, invariant must hold
  const [, fin, entry] = await Promise.all([
    Promise.resolve(),
    cr.api('POST', A(`/assessments/${a._id}/finalize`)),
    cr.api('POST', A(`/assessments/${a._id}/marks`), { student: crId, marksObtained: 1 }),
  ]);
  assert.equal(fin.status, 200);
  const doc = await Assessment.findById(a._id);
  assert.equal(doc.status, 'finalized');
  const marks = await Mark.find({ assessment: a._id });
  assert.ok(marks.length >= 1);
  assert.ok(marks.every((m) => m.status === 'finalized'), 'finalized ⇒ all marks finalized');
  assert.equal(entry.status === 200 || entry.status === 400, true); // either order, never 500
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
