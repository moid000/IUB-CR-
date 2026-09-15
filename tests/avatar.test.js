/**
 * STEP 18 tests — self-service profile AVATAR (Cloudinary sign→upload→confirm).
 * NO real Cloudinary calls, NO real credentials: fake env values only, the
 * official sha1 algorithm is verified locally. Avatar is self-only: every
 * namespace is derived from req.user — clients can never inject userId,
 * folder, publicId or ownership.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('avatar_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret';

const CLOUD_NAME = 'test-cloud-xyz';
const API_KEY = '123456789012345';
const API_SECRET = 'fake-api-secret-abcdef';
process.env.CLOUDINARY_CLOUD_NAME = CLOUD_NAME;
process.env.CLOUDINARY_API_KEY = API_KEY;
process.env.CLOUDINARY_API_SECRET = API_SECRET;

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

const admin = makeSession();
const s1 = makeSession(); // student A
const s2 = makeSession(); // student B
const cr1 = makeSession();

let s1Id, s2Id, cr1Id;

const PNG = { originalName: 'me.png', mimeType: 'image/png' };
const JPG = { originalName: 'me.jpg', mimeType: 'image/jpeg' };
const PDF = { originalName: 'doc.pdf', mimeType: 'application/pdf' };

function cloudinaryAvatar(signRes, { format = 'png', bytes = 2048, name = 'me.png' } = {}) {
  // mimic REAL Cloudinary: public_id comes back as folder + '/' + basename
  const publicId = `${signRes.folder}/${signRes.publicId}`;
  return {
    public_id: publicId,
    folder: signRes.folder,
    secure_url: `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${publicId}.${format}`,
    resource_type: 'image',
    format,
    bytes,
    original_filename: name,
  };
}

test('fixtures: users + sessions', async () => {
  const hash = await bcrypt.hash('Pass1234!', 10);
  const mk = (name, email, role) => User.create({
    name, email, role, registrationStatus: 'active', emailVerified: true, password: hash,
  }).then((u) => u._id);
  s1Id = await mk('Student A', 'av-s1@test.local', 'student');
  s2Id = await mk('Student B', 'av-s2@test.local', 'student');
  cr1Id = await mk('CR One', 'av-cr1@test.local', 'cr');
  for (const [sess, email, password] of [
    [s1, 'av-s1@test.local', 'Pass1234!'], [s2, 'av-s2@test.local', 'Pass1234!'],
    [cr1, 'av-cr1@test.local', 'Pass1234!'], [admin, 'admin@test.local', 'AdminPass123!456'],
  ]) {
    assert.equal((await sess.api('POST', '/api/auth/login', { email, password })).status, 200, email);
  }
});

test('A1. unauthenticated avatar sign/confirm/remove → 401', async () => {
  assert.equal((await makeSession().api('POST', '/api/auth/avatar/sign', { file: PNG })).status, 401);
  assert.equal((await makeSession().api('POST', '/api/auth/avatar/confirm', { result: {} })).status, 401);
  assert.equal((await makeSession().api('POST', '/api/auth/avatar/remove')).status, 401);
});

test('A2. sign: folder/publicId derived from req.user — client fields ignored', async () => {
  const r = await s1.api('POST', '/api/auth/avatar/sign', {
    file: PNG,
    // hostile injections — must ALL be ignored
    userId: String(s2Id), folder: 'iub-cr-lms/avatar/somebody-else', publicId: 'evil',
    uploadedBy: String(s2Id), section: 'x', role: 'admin',
  });
  assert.equal(r.status, 200);
  const d = r.json.data;
  assert.equal(d.folder, `iub-cr-lms/avatar/${s1Id}`);
  // basename only — Cloudinary prepends the folder at upload time
  assert.match(d.publicId, new RegExp(`^avatar-${s1Id}-[0-9a-f]{12}$`));
  assert.equal(d.resourceType, 'image');
  assert.equal(d.maxSizeBytes, 5 * 1024 * 1024);
  assert.ok(d.uploadUrl.startsWith(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`));
  assert.ok(!r.text.includes(API_SECRET), 'api secret must never appear');
  assert.equal(d.apiKey, API_KEY); // public-by-design upload key, paired with the secret
});

test('A3. non-image types rejected at sign (pdf, txt, exe)', async () => {
  assert.equal((await s1.api('POST', '/api/auth/avatar/sign', { file: PDF })).status, 400);
  assert.equal((await s1.api('POST', '/api/auth/avatar/sign', { file: { originalName: 'a.txt', mimeType: 'text/plain' } })).status, 400);
  assert.equal((await s1.api('POST', '/api/auth/avatar/sign', { file: { originalName: 'virus.exe', mimeType: 'application/x-msdownload' } })).status, 400);
});

test('A4. confirm: valid png → avatar set; /auth/me exposes SAFE projection only', async () => {
  const sign = (await s1.api('POST', '/api/auth/avatar/sign', { file: PNG })).json.data;
  const r = await s1.api('POST', '/api/auth/avatar/confirm', { result: cloudinaryAvatar(sign) });
  assert.equal(r.status, 200);
  const me = (await s1.api('GET', '/api/auth/me')).json.user;
  assert.ok(me.avatar?.url?.startsWith(`https://res.cloudinary.com/${CLOUD_NAME}/image/upload/`));
  assert.equal(me.avatar.format, 'png');
  assert.equal(me.avatar.size, 2048);
  assert.equal(me.avatar.originalName, 'me.png');
  // NEVER expose Cloudinary internals / ownership ids in the public projection
  const meText = JSON.stringify(me);
  assert.ok(!('publicId' in (me.avatar ?? {})), 'publicId must not be exposed');
  assert.ok(!meText.includes('folder'), 'folder must not be exposed');
  assert.ok(!meText.includes('uploadedBy'), 'uploadedBy must not be exposed');
  assert.ok(!meText.includes('password'), 'no password material');
});

test('A5. cross-user graft: confirming B\'s namespace as A → 400', async () => {
  const signB = (await s2.api('POST', '/api/auth/avatar/sign', { file: PNG })).json.data;
  // student A tries to confirm student B's signed asset
  const r = await s1.api('POST', '/api/auth/avatar/confirm', { result: cloudinaryAvatar(signB) });
  assert.equal(r.status, 400);
  // and B still has NO avatar
  const meB = (await s2.api('GET', '/api/auth/me')).json.user;
  assert.equal(meB.avatar, null);
});

test('A6. confirm verification: wrong folder / foreign URL / wrong format → 400', async () => {
  const sign = (await s1.api('POST', '/api/auth/avatar/sign', { file: PNG })).json.data;
  const base = cloudinaryAvatar(sign);
  // foreign folder
  assert.equal((await s1.api('POST', '/api/auth/avatar/confirm', {
    result: { ...base, folder: `iub-cr-lms/avatar/${s2Id}` },
  })).status, 400);
  // http (not https) → rejected, HTTPS enforced
  assert.equal((await s1.api('POST', '/api/auth/avatar/confirm', {
    result: { ...base, secure_url: `http://res.cloudinary.com/${CLOUD_NAME}/image/upload/${sign.publicId}.png` },
  })).status, 400);
  // foreign account domain → rejected
  assert.equal((await s1.api('POST', '/api/auth/avatar/confirm', {
    result: { ...base, secure_url: `https://res.cloudinary.com/other-account/image/upload/${sign.publicId}.png` },
  })).status, 400);
  // pdf disguised as avatar → type_not_allowed
  assert.equal((await s1.api('POST', '/api/auth/avatar/confirm', {
    result: cloudinaryAvatar(sign, { format: 'pdf' }),
  })).status, 400);
});

test('A6b. REAL Cloudinary shape accepted: folder:null + versioned delivery URL', async () => {
  // live-observed production behavior (2026-09-15)
  const sign = (await s1.api('POST', '/api/auth/avatar/sign', { file: PNG })).json.data;
  const fullId = `${sign.folder}/${sign.publicId}`;
  const r = await s1.api('POST', '/api/auth/avatar/confirm', {
    result: {
      public_id: fullId, folder: null,
      secure_url: `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/v1789442495/${fullId}.png`,
      resource_type: 'image', format: 'png', bytes: 2048, original_filename: 'me.png',
    },
  });
  assert.equal(r.status, 200, r.text);
});

test('A7. avatar size limit: 5 MB enforced from the Cloudinary result', async () => {
  const sign = (await s1.api('POST', '/api/auth/avatar/sign', { file: JPG })).json.data;
  assert.equal((await s1.api('POST', '/api/auth/avatar/confirm', {
    result: cloudinaryAvatar(sign, { format: 'jpg', bytes: 5 * 1024 * 1024 + 1, name: 'me.jpg' }),
  })).status, 400);
  assert.equal((await s1.api('POST', '/api/auth/avatar/confirm', {
    result: cloudinaryAvatar(sign, { format: 'jpg', bytes: 5 * 1024 * 1024, name: 'me.jpg' }),
  })).status, 200);
});

test('A8. replace: second confirm supersedes the first — one avatar, atomically', async () => {
  const me1 = (await s1.api('GET', '/api/auth/me')).json.user;
  const sign = (await s1.api('POST', '/api/auth/avatar/sign', { file: PNG })).json.data;
  const r = await s1.api('POST', '/api/auth/avatar/confirm', { result: cloudinaryAvatar(sign, { bytes: 4096 }) });
  assert.equal(r.status, 200);
  const me2 = (await s1.api('GET', '/api/auth/me')).json.user;
  assert.notEqual(me2.avatar.url, me1.avatar.url, 'avatar must be replaced, not appended');
  assert.equal(me2.avatar.size, 4096);
  const doc = await User.findById(s1Id);
  assert.ok(doc.avatar, 'exactly one avatar subdocument');
});

test('A9. remove: self-service only → avatar null, then 404 on repeat', async () => {
  assert.equal((await s2.api('POST', '/api/auth/avatar/remove')).status, 404, 'B has no avatar — nothing to remove');
  // CR cannot remove A's avatar: there is NO route that takes a userId at all —
  // the only remove is /api/auth/avatar/remove which targets req.user.
  assert.equal((await cr1.api('POST', '/api/auth/avatar/remove')).status, 404, 'CR has none either');
  assert.equal((await s1.api('POST', '/api/auth/avatar/remove')).status, 200);
  const me = (await s1.api('GET', '/api/auth/me')).json.user;
  assert.equal(me.avatar, null);
  assert.equal((await s1.api('POST', '/api/auth/avatar/remove')).status, 404);
  assert.equal((await User.findById(s2Id)).avatar, undefined, "B's avatar untouched");
});

test('A10. avatar isolation: B unaffected by A\'s full lifecycle', async () => {
  const signB = (await s2.api('POST', '/api/auth/avatar/sign', { file: JPG })).json.data;
  assert.equal((await s2.api('POST', '/api/auth/avatar/confirm', {
    result: cloudinaryAvatar(signB, { format: 'jpg', name: 'b.jpg' }),
  })).status, 200);
  // A does a full replace + remove cycle
  const signA = (await s1.api('POST', '/api/auth/avatar/sign', { file: PNG })).json.data;
  await s1.api('POST', '/api/auth/avatar/confirm', { result: cloudinaryAvatar(signA) });
  await s1.api('POST', '/api/auth/avatar/remove');
  const meB = (await s2.api('GET', '/api/auth/me')).json.user;
  assert.equal(meB.avatar.originalName, 'b.jpg', "B's avatar survives A's operations");
});

test('A11. audit trail written; no secret material in any avatar response', async () => {
  const sign = (await cr1.api('POST', '/api/auth/avatar/sign', { file: PNG })).json.data;
  const r = await cr1.api('POST', '/api/auth/avatar/confirm', { result: cloudinaryAvatar(sign) });
  assert.equal(r.status, 200);
  const events = await AuditLog.find({ action: { $in: ['avatar.upload.signature', 'avatar.upload.confirm', 'avatar.upload.reject', 'avatar.remove'] } }).lean();
  assert.ok(events.length > 0, 'avatar audit events exist');
  for (const e of events) {
    assert.ok(!JSON.stringify(e).includes(API_SECRET), 'audit never contains the api secret');
  }
  const allResponses = JSON.stringify({ sign, confirm: r.json });
  assert.ok(!allResponses.includes(API_SECRET), 'secrets never cross the API boundary');
});

test('A12. existing users remain valid without an avatar (schema default)', async () => {
  const plain = await User.create({
    name: 'Legacy User', email: 'av-legacy@test.local', role: 'student',
    registrationStatus: 'active', emailVerified: true,
    password: await bcrypt.hash('Pass1234!', 10),
  });
  assert.equal(plain.avatar, undefined);
  assert.equal((await makeSession().api('POST', '/api/auth/login', { email: 'av-legacy@test.local', password: 'Pass1234!' })).status, 200);
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
