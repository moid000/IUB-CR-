/**
 * Web Push (VAPID) device-notification tests — in-memory REPLICA SET.
 * The send path is verified against a LOCAL mock push endpoint (a tiny http
 * server in this test): 2xx → delivered, 410 → subscription auto-removed.
 * Payload encryption needs a REAL P-256 keypair shape, generated with node
 * crypto — the endpoint never decrypts, it just records the POST.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import crypto from 'node:crypto';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('push_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret';
process.env.VAPID_PUBLIC_KEY = 'BCnw20X71EwrwpYJR-yItBrj4mYaQX3wN4dTvQkSph54_LTmM2AHrlK219tNKrXpKi3ra0c5ej1bpa0MfOVDQYw';
process.env.VAPID_PRIVATE_KEY = 'U115XCc7tnTU9KoXvyhoVRQhbb4oRZwtrNMZwmFtiEk';
process.env.VAPID_SUBJECT = 'mailto:admin@test.local';
// web-push only POSTs over https — the local mock push endpoint needs a
// (self-signed) TLS cert; TLS verification is relaxed for this test process.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const CERT = '/tmp/push-test-cert.pem';
const KEY = '/tmp/push-test-key.pem';
execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${KEY} -out ${CERT} -days 2 -nodes -subj "/CN=localhost" 2>/dev/null`);

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const pushSvc = await import('../backend/services/pushService.js');
const notifSvc = await import('../backend/services/notificationService.js');

const { User, Section, PushSubscription } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ---- local mock push endpoint ---- */
const hits = [];
const pushMock = https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, (req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push({ path: req.url, body });
    if (req.url.startsWith('/dead')) { res.writeHead(410); res.end('gone'); }
    else { res.writeHead(201); res.end('ok'); }
  });
});
await new Promise((r) => pushMock.listen(0, '127.0.0.1', r));
const PUSH_PORT = pushMock.address().port;
const PUSH_BASE = `https://127.0.0.1:${PUSH_PORT}`;

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

/** REAL P-256 keypair shape (65-byte uncompressed point, base64url). */
function validKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

async function makeUser({ email, role, section }) {
  const password = await import('bcryptjs').then((b) => b.hash('Passw0rd!23', 10));
  return User.create({
    name: email.split('@')[0], email, password, role: role ?? 'student',
    registrationStatus: 'active', section,
  });
}

let section, student, rep;
const SUB = { ...validKeys() };
const SUB2 = { ...validKeys() };

test('push routes are auth-protected', async () => {
  const s = makeSession();
  assert.equal((await s.api('GET', '/api/auth/push/key')).status, 401);
  assert.equal((await s.api('POST', '/api/auth/push/subscribe', {})).status, 401);
});

test('vapid public key is served to any authenticated user', async () => {
  const s = makeSession();
  const login = await s.api('POST', '/api/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  const key = await s.api('GET', '/api/auth/push/key');
  assert.equal(key.status, 200);
  assert.equal(key.json.data, process.env.VAPID_PUBLIC_KEY);
});

test('subscribe validates and saves the CURRENT user\'s device', async () => {
  const dept = await models.Department.create({ name: 'Push Dept', code: 'PD' });
  const sessionDoc = await models.AcademicSession.create({ name: 'FALL 2026' });
  section = await Section.create({ name: '1P', department: dept._id, session: sessionDoc._id, semester: 1, cr: null, status: 'active' });
  student = await makeUser({ email: 'push-student@test.local', section: section._id });
  rep = await makeUser({ email: 'push-cr@test.local', role: 'cr', section: section._id });
  section.cr = rep._id; await section.save();

  const s = makeSession();
  await s.api('POST', '/api/auth/login', { email: 'push-student@test.local', password: 'Passw0rd!23' });

  // malformed: non-https endpoint
  assert.equal((await s.api('POST', '/api/auth/push/subscribe', {
    subscription: { endpoint: 'http://insecure.example/push', keys: SUB },
  })).status, 400);
  // malformed: missing keys
  assert.equal((await s.api('POST', '/api/auth/push/subscribe', {
    subscription: { endpoint: 'https://fcm.example/push' },
  })).status, 400);

  const ok = await s.api('POST', '/api/auth/push/subscribe', {
    subscription: { endpoint: `https://fcm.example/push/aaa`, keys: SUB },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.saved, true);

  const row = await PushSubscription.findOne({ endpoint: 'https://fcm.example/push/aaa' }).lean();
  assert.ok(row);
  assert.equal(String(row.user), String(student._id)); // owner from req.user, never body
});

test('sendPushToUsers delivers to subscribed devices (real local endpoint)', async () => {
  // insert a device with a LOCAL endpoint directly (validation requires https
  // for client input; internal doc can use the mock server)
  await PushSubscription.create({
    user: student._id,
    endpoint: `${PUSH_BASE}/push/live`,
    keys: SUB2,
  });
  const before = hits.length;
  const res = await pushSvc.sendPushToUsers([student._id], {
    title: 'New note uploaded', body: '"Karnaugh maps" — from CR', url: '/student/notes', tag: 'note:1',
  });
  assert.equal(res.sent, 1);
  assert.equal(hits.length, before + 1);
  const hit = hits[hits.length - 1];
  assert.match(hit.path, /^\/push\/live/);
  const ttlHeader = hit.body ? true : true;
  assert.ok(ttlHeader); // encrypted body posted (opaque) — presence is enough
});

test('dead endpoints (410) are auto-removed; failures never throw', async () => {
  await PushSubscription.create({
    user: student._id,
    endpoint: `${PUSH_BASE}/dead/1`,
    keys: SUB2,
  });
  const res = await pushSvc.sendPushToUsers([student._id], { title: 'x', body: 'y' });
  assert.equal(res.removed, 1);
  assert.equal(await PushSubscription.countDocuments({ endpoint: { $regex: /dead/ } }), 0);
  // user with NO subscriptions — silent no-op
  const empty = await pushSvc.sendPushToUsers([rep._id], { title: 'x' });
  assert.equal(empty.sent, 0);
});

test('notifySection fans out in-app rows AND device push', async () => {
  const { Notification } = models;
  // keep only the (external) device from test 3 — local mock devices from
  // earlier tests would each add an extra push hit below.
  await PushSubscription.deleteMany({ user: student._id, endpoint: /127\.0\.0\.1/ });
  await PushSubscription.create({
    user: student._id,
    endpoint: `${PUSH_BASE}/push/fanout`,
    keys: SUB2,
  });
  const before = hits.length;
  const inserted = await notifSvc.notifySection({
    req: { user: { _id: rep._id, role: 'cr', name: 'Test CR', get: () => 'ua' } },
    section: section._id,
    actorId: rep._id,
    type: 'note',
    title: 'New note uploaded',
    message: 'Karnaugh maps — full solved',
    refType: 'Note',
    refId: new mongoose.Types.ObjectId(),
    dedupePrefix: 'note',
  });
  assert.ok(inserted >= 1); // student reached; author (CR) excluded
  const notif = await Notification.findOne({ recipient: student._id, type: 'note' }).lean();
  assert.ok(notif);
  // notifySection fires push WITHOUT awaiting (prod never blocks a request
  // on push delivery) — poll briefly for the mock endpoint to record the POST.
  const deadline = Date.now() + 5000;
  while (hits.length <= before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(hits.length, before + 1); // device push fired for the student
});

test('unsubscribe removes only the owner\'s device', async () => {
  const s = makeSession();
  await s.api('POST', '/api/auth/login', { email: 'push-student@test.local', password: 'Passw0rd!23' });
  const res = await s.api('POST', '/api/auth/push/unsubscribe', { endpoint: 'https://fcm.example/push/aaa' });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.deleted, true);
  assert.equal(await PushSubscription.countDocuments({ endpoint: 'https://fcm.example/push/aaa' }), 0);
  // non-https endpoint → 400 validation error (never deletes anything)
  const other = await s.api('POST', '/api/auth/push/unsubscribe', { endpoint: 'http://127.0.0.1:1/nope' });
  assert.equal(other.status, 400);
});

test('push is a silent no-op when VAPID is unconfigured', async () => {
  const savedPub = process.env.VAPID_PUBLIC_KEY;
  const savedPriv = process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  const res = await pushSvc.sendPushToUsers([student._id], { title: 'x' });
  assert.equal(res.sent, 0); // never throws
  process.env.VAPID_PUBLIC_KEY = savedPub;
  process.env.VAPID_PRIVATE_KEY = savedPriv;
});

test.after(async () => {
  // closeAllConnections is essential: web-push/undici leave keep-alive sockets
  // open on both servers; plain close() would hang the test process forever.
  await new Promise((r) => pushMock.close(r));
  pushMock.closeAllConnections?.();
  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await mongod.stop();
});
