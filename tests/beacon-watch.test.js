/**
 * BEACON WATCH tests (owner spec 2026-10-14: self-hosted, zero-Base44 crash
 * alerting that rides the existing 5-minute deadline-sweep ping). Covers:
 *   BW-1: first pass initializes the cursor and never alerts on old rows
 *   BW-2: a beacon newer than the cursor triggers ONE Brevo alert email
 *   BW-3: the cursor advances — the same beacon never alerts twice
 *   BW-4: alert throttle — a second burst inside the window advances the
 *         cursor but skips the email
 *   BW-5: no new beacons => quiet pass, no email
 */
import test from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('beacon_watch_test');
process.env.JWT_SECRET = 'bw-test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-brevo-key-xkeysib000000';
process.env.BREVO_SENDER_EMAIL = 'tri3m@test.local';
process.env.WHATSAPP_WATCHDOG_ALERT_EMAILS = 'owner@test.local';
process.env.DEADLINE_SWEEP_SECRET = 'bw-sweep-secret';
// No throttling surprises: 15-minute window, tests run in milliseconds.
process.env.BEACON_ALERT_MINUTES = '15';

// Capture Brevo sends without any network.
const brevoCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.brevo.com')) {
    brevoCalls.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
    return { ok: true, status: 200, json: async () => ({}) };
  }
  return realFetch(url, opts);
};

// models/index.js only declares models — the connection itself is opened by
// app.js in production; for a service-level test we connect explicitly.
const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGODB_URI);
const { ClientError, WatchdogState } = await import('../backend/models/index.js');
const { runBeaconWatch } = await import('../backend/services/beaconWatchService.js');

test('BW-1: first pass initializes the cursor and never alerts on old rows', async () => {
  // A pre-activation beacon must be ignored forever.
  await ClientError.create({
    kind: 'root', message: 'old historical crash', path: '/deploy-check',
  });
  const out = await runBeaconWatch();
  assert.equal(out.initialized, true);
  assert.equal(out.newErrors, 0);
  assert.equal(out.alerted, false);
  assert.equal(brevoCalls.length, 0);
  const cursor = await WatchdogState.findOne({ key: 'beacon-watch:last-seen' }).lean();
  assert.ok(cursor, 'cursor created');
});

test('BW-2: a new beacon triggers exactly one Brevo alert email', async () => {
  await ClientError.create({
    kind: 'page',
    message: 'TypeError: bot.geminiKeysMasked is not a function',
    path: '/admin/administration',
  });
  const out = await runBeaconWatch();
  assert.equal(out.newErrors, 1);
  assert.equal(out.alerted, true);
  assert.equal(brevoCalls.length, 1);
  assert.match(brevoCalls[0].body.subject, /1 new client crash beacon/);
  assert.match(brevoCalls[0].body.textContent, /geminiKeysMasked/);
  const to = brevoCalls[0].body.to.map((r) => r.email);
  assert.deepEqual(to, ['owner@test.local']);
});

test('BW-3: cursor advanced — the same beacon never alerts twice', async () => {
  const out = await runBeaconWatch();
  assert.equal(out.newErrors, 0);
  assert.equal(out.alerted, false);
  assert.equal(brevoCalls.length, 1); // still only the BW-2 email
});

test('BW-4: throttle — second burst inside the window skips the email', async () => {
  await ClientError.create({
    kind: 'preload', message: 'Failed to fetch dynamically imported module', path: '/admin',
  });
  const out = await runBeaconWatch();
  // Beacon is consumed (cursor advanced) but the email is throttled out.
  assert.equal(out.newErrors, 1);
  assert.equal(out.alerted, false);
  assert.equal(brevoCalls.length, 1);
  // And it is not re-reported afterwards.
  const again = await runBeaconWatch();
  assert.equal(again.newErrors, 0);
});

test('BW-5: quiet pass with no beacons sends nothing', async () => {
  const out = await runBeaconWatch();
  assert.deepEqual(out, { initialized: false, newErrors: 0, alerted: false, rows: [] });
  assert.equal(brevoCalls.length, 1);
});

// Close the REPL set + mongoose handles so the test process exits cleanly
// and the rest of the suite can proceed.
after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
