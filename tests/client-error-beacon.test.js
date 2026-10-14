/**
 * CLIENT-ERROR BEACON tests (owner incident 2026-10-14: the Administration
 * page hits the "This page couldn't load" boundary card on his device, but
 * the real error is invisible — this beacon is how the actual crash text
 * reaches the server). Covers:
 *   B1: POST /api/client-error accepts a sanitized report (no auth needed)
 *   B2: caps are enforced — oversized fields are truncated, never 500
 *   B3: garbage payloads never 500 (beacon must never break a crash path)
 *   B4: rate limit kicks in eventually (no unbounded writes)
 *   B5: ops-diagnostics exposes the recent errors to the owner (sweep-secret)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('client_error_test');
process.env.JWT_SECRET = 'ce-test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-brevo-key-xkeysib000000';
process.env.DEADLINE_SWEEP_SECRET = 'ce-sweep-secret';

const { default: app } = await import('../backend/app.js');
const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const { ClientError } = await import('../backend/models/index.js');

test('B1: beacon accepts a crash report and stores sanitized fields', async () => {
  const res = await fetch(`${BASE}/api/client-error`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'page',
      message: 'TypeError: bot.geminiKeysMasked is not a function',
      stack: 'at AdministrationPage (AdministrationPage.jsx:290:15)',
      componentStack: 'in AdministrationPage\nin RouteErrorBoundary',
      path: '/admin/administration',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  const row = await ClientError.findOne({ kind: 'page' }).lean();
  assert.ok(row);
  assert.ok(row.message.startsWith('TypeError: bot.gemini'));
  assert.equal(row.path, '/admin/administration');
});

test('B2: oversized fields are truncated, not rejected', async () => {
  const big = 'x'.repeat(5000);
  const res = await fetch(`${BASE}/api/client-error`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'root', message: big, stack: big, componentStack: big, path: '/' }),
  });
  assert.equal(res.status, 200);
  const rows = await ClientError.find({ kind: 'root' }).lean();
  assert.equal(rows.length, 1);
  assert.ok(rows[0].message.length <= 300);
  assert.ok(rows[0].stackHead.length <= 300);
  assert.ok(rows[0].componentHead.length <= 300);
});

test('B3: garbage payloads never 500', async () => {
  const res = await fetch(`${BASE}/api/client-error`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'weird-kind', message: { nested: 'object' }, nope: true }),
  });
  assert.equal(res.status, 200); // sanitized to defaults, still accepted
  const res2 = await fetch(`${BASE}/api/client-error`, { method: 'POST' }); // no body at all
  assert.ok(res2.status === 200 || res2.status === 400);
  assert.notEqual(res2.status, 500);
});

test('B4: rate limit caps writes per IP', async () => {
  let last = 0;
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`${BASE}/api/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'page', message: `spam ${i}` }),
    });
    last = res.status;
    if (res.status === 429) break;
  }
  assert.equal(last, 429); // the window limit (30) stops the flood
});

test('B5: ops-diagnostics exposes recent client errors to the owner', async () => {
  const res = await fetch(`${BASE}/api/whatsapp/ops-diagnostics?secret=ce-sweep-secret`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.data.clientErrors));
  assert.ok(body.data.clientErrors.length >= 2);
  const first = body.data.clientErrors[0];
  assert.ok(first.message && typeof first.message === 'string');
  assert.ok(first.at || first.path !== undefined);
  assert.ok(first.componentHead !== undefined && first.stackHead !== undefined);
});

test('cleanup', async () => {
  server.close();
  const { default: mongoose } = await import('mongoose');
  await mongoose.disconnect();
  await mongod.stop();
});
