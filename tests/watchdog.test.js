/**
 * UltraMsg trial-watchdog tests — in-memory REPLICA SET.
 * All network (UltraMsg status API + user.ultramsg.com dashboard) is stubbed
 * via globalThis.fetch: healthy, stopped→renew, renew-failed alert, QR alert
 * (with 20h throttle), unknown-status alert, and the secret-guarded route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('watchdog_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.ATTENDANCE_SECRET = 'test-only-attendance-secret';
process.env.VAPID_PUBLIC_KEY = 'BCnw20X71EwrwpYJR-yItBrj4mYaQX3wN4dTvQkSph54_LTmM2AHrlK219tNKrXpKi3ra0c5ej1bpa0MfOVDQYw';
process.env.VAPID_PRIVATE_KEY = 'U115XCc7tnTU9KoXvyhoVRQhbb4oRZwtrNMZwmFtiEk';
process.env.VAPID_SUBJECT = 'mailto:admin@test.local';
// watchdog config
process.env.ULTRAMSG_INSTANCE_ID = 'instance138500';
process.env.ULTRAMSG_TOKEN = 'test-token';
process.env.ULTRAMSG_DASHBOARD_EMAIL = 'owner@example.com';
process.env.ULTRAMSG_DASHBOARD_PASSWORD = 'dashboard-pass';
process.env.ULTRAMSG_INSTANCE_NUMBER = '138500';
process.env.WHATSAPP_WATCHDOG_ALERT_EMAILS = 'owner@example.com,cr@example.com';
process.env.DEADLINE_SWEEP_SECRET = 'test-sweep-secret';
process.env.WATCHDOG_VERIFY_WAIT_MS = '5';

process.env.BREVO_SENDER_EMAIL = 'noreply@example.com';

// app.js connects mongoose to the in-memory replica set on import — must
// happen BEFORE any model operation
const { default: mongoose } = await import('mongoose');
const { default: app } = await import('../backend/app.js');
const models = await import('../backend/models/index.js');
const { runWatchdog } = await import('../backend/services/ultramsgWatchdogService.js');
await mongoose.connect(process.env.MONGODB_URI); // app connects lazily; tests connect eagerly

// ---- fetch stubbing ------------------------------------------------------
const realFetch = globalThis.fetch;
let calls = [];
let responses = []; // functions: (url, options) => {status, json, text, headers}

function jsonRes(body, headers = {}) {
  return {
    status: 200,
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { getSetCookie: () => headers.setCookies ?? [] },
  };
}

function stubFetch(list) {
  calls = [];
  responses = list;
  globalThis.fetch = (url, options = {}) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch: ' + url);
    calls.push({ url: String(url), options });
    return typeof next === 'function' ? next(String(url), options) : next;
  };
}

const STATUS_OK = jsonRes({ status: { accountStatus: { status: 'authenticated', substatus: 'connected' } } });
const STATUS_STOPPED = jsonRes({ error: 'Instance stopped. Stopped due to non-payment' });
const STATUS_QR = jsonRes({ status: { accountStatus: { status: 'qr', substatus: 'normal' } } });
const SEED_COOKIE = { setCookies: ['PHPSESSID=abc123; path=/'] };
const LOGIN_OK = jsonRes({ success: 'done' }, SEED_COOKIE);
const EXTEND_OK = jsonRes({ success: 'instance extended' });

async function cleanupState() {
  await models.WatchdogState.deleteMany({});
}

test.after(async () => {
  globalThis.fetch = realFetch;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await mongod.stop();
});

// ---- service tests -------------------------------------------------------

test('healthy instance → action none, no dashboard calls', async () => {
  await cleanupState();
  stubFetch([STATUS_OK]);
  const report = await runWatchdog();
  assert.equal(report.configured, true);
  assert.equal(report.action, 'none');
  assert.equal(report.renewed, false);
  assert.equal(calls.length, 1); // only the status check
  assert.match(calls[0].url, /instance138500\/instance\/status/);
});

test('stopped instance → dashboard login + extend_trial + verify', async () => {
  await cleanupState();
  stubFetch([
    STATUS_STOPPED, // 1) status check
    jsonRes({}, SEED_COOKIE), // 2) GET / seeds session
    LOGIN_OK, // 3) login POST
    EXTEND_OK, // 4) extend POST
    STATUS_OK, // 5) verify status
  ]);
  const report = await runWatchdog();
  assert.equal(report.action, 'renew');
  assert.equal(report.renewed, true);
  assert.equal(report.statusAfter, 'authenticated');

  // call order: status → seed → login → extend
  assert.equal(calls[1].url, 'https://user.ultramsg.com/');
  assert.equal(calls[2].url, 'https://user.ultramsg.com/request/post.php');
  const loginBody = calls[2].options.body.toString();
  assert.equal(loginBody, 'email=owner%40example.com&password=dashboard-pass&signin=Sign+in');
  const extendBody = calls[3].options.body.toString();
  assert.equal(extendBody, 'extend_trial=138500');
});

test('stopped instance but extend fails → alert email, renewed false', async () => {
  await cleanupState();
  stubFetch([
    STATUS_STOPPED,
    jsonRes({}, SEED_COOKIE),
    LOGIN_OK,
    jsonRes({ error: 'instance is not stopped' }), // extend fails
    jsonRes({ messageId: 'ok' }, {}), // brevo email
  ]);
  const report = await runWatchdog();
  assert.equal(report.renewed, false);
  assert.equal(report.error, 'instance is not stopped');
  assert.equal(report.alerted, true);
  // brevo was called last
  assert.equal(calls.at(-1).url, 'https://api.brevo.com/v3/smtp/email');
});

test('QR status → alert once, then throttled', async () => {
  await cleanupState();
  stubFetch([
    STATUS_QR,
    jsonRes({ messageId: 'ok' }), // brevo
    STATUS_QR,
    STATUS_QR, // second pass: only status check (brevo NOT called)
  ]);
  const first = await runWatchdog();
  assert.equal(first.status, 'qr');
  assert.equal(first.alerted, true);

  const second = await runWatchdog();
  assert.equal(second.alerted, false);
  assert.equal(second.reason, 'throttled');
  assert.equal(calls.filter((c) => c.url.includes('brevo')).length, 1);
});

test('unknown unhealthy status → alert with status name', async () => {
  await cleanupState();
  stubFetch([
    jsonRes({ status: { accountStatus: { status: 'loading', substatus: 'weird' } } }),
    jsonRes({ messageId: 'ok' }),
  ]);
  const report = await runWatchdog();
  assert.equal(report.status, 'loading');
  assert.equal(report.alerted, true);
});

test('not configured → configured:false, no fetch', async () => {
  const { env } = await import('../backend/config/env.js');
  const saved = env.whatsapp.token;
  env.whatsapp.token = undefined;
  try {
    globalThis.fetch = () => assert.fail('fetch must not be called');
    const report = await runWatchdog();
    assert.equal(report.configured, false);
    assert.deepEqual(Object.keys(report), ['configured']);
  } finally {
    env.whatsapp.token = saved;
    globalThis.fetch = realFetch;
  }
});

// ---- route tests ---------------------------------------------------------

async function request(path, secret) {
  const server = app.listen(0);
  const port = server.address().port;
  const allClose = () => new Promise((r) => server.closeAllConnections?.() ?? r());
  try {
    const headers = secret ? { 'x-sweep-secret': secret } : {};
    const res = await realFetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await allClose();
    await new Promise((r) => server.close(r));
  }
}

test('route /api/whatsapp/watchdog requires the secret', async () => {
  stubFetch([STATUS_OK]);
  const no = await request('/api/whatsapp/watchdog');
  assert.equal(no.status, 401);
  const wrong = await request('/api/whatsapp/watchdog', 'wrong-secret');
  assert.equal(wrong.status, 401);
});

test('route /api/whatsapp/watchdog with secret returns the report', async () => {
  await cleanupState();
  stubFetch([STATUS_OK]);
  const ok = await request('/api/whatsapp/watchdog?secret=test-sweep-secret', null);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.data.action, 'none');
  // POST with header works too
  const post = await request('/api/whatsapp/watchdog', 'test-sweep-secret');
  assert.equal(post.status, 200);
  assert.equal(post.body.data.configured, true);
});
