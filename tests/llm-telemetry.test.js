/**
 * OWNER FEATURE 2026-10-18 — LLM MODEL HEALTH & LIMITS.
 * Telemetry counters (recordLlm upserts), the health snapshot aggregation
 * (breaker state, 24h source split, per-model rows), Groq's real
 * rate-limits mapping, and the admin-only /api/admin/chatbot/health route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const replset = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = replset.getUri('llmhealth_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
process.env.GOOGLE_API_KEY = 'test-gemini-key';
process.env.GROQ_API_KEY = 'gsk-test-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const {
  recordLlm, llmHealthSnapshot, groqRateLimits, pktDayKey,
} = await import('../backend/services/llmTelemetryService.js');

// app.js connects lazily per HTTP request; direct model ops in tests need an
// explicit connection (same pattern as the other in-memory suites).
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const { LlmUsage, ChatbotLog, ChatbotSetting } = models;
const server = app.listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await replset.stop();
});

/* ------------------------- recordLlm counters --------------------------- */

test('recordLlm: upserts one doc per (day,provider,model) and counts ok / 429 / other', async () => {
  recordLlm({ provider: 'gemini', model: 'gemini-3.8-flash', ok: true });
  recordLlm({ provider: 'gemini', model: 'gemini-3.8-flash', ok: true });
  recordLlm({ provider: 'gemini', model: 'gemini-3.8-flash', ok: false, status: 429 });
  recordLlm({ provider: 'gemini', model: 'gemini-3.8-flash', ok: false, status: 'timeout' });
  recordLlm({ provider: 'groq', model: 'openai/gpt-oss-120b', ok: true });
  // fire-and-forget: give the upserts a beat to land
  await new Promise((r) => setTimeout(r, 150));

  const rows = await LlmUsage.find({ day: pktDayKey() }).lean();
  const g = rows.find((r) => r.provider === 'gemini');
  assert.ok(g, 'gemini row created');
  assert.equal(g.calls, 4);
  assert.equal(g.ok, 2);
  assert.equal(g.fail429, 1);
  assert.equal(g.failOther, 1);
  assert.match(g.lastError, /429|timeout/i); // fire-and-forget: order of the two failures is not guaranteed
  assert.ok(g.lastErrorAt, 'failure timestamp recorded');
  const q = rows.find((r) => r.provider === 'groq');
  assert.ok(q, 'groq row created');
  assert.equal(q.calls, 1);
  assert.equal(q.ok, 1);
});

test('recordLlm: never throws (telemetry can not break the reply path)', async () => {
  assert.doesNotThrow(() => recordLlm({ provider: 'gemini' })); // no model
  assert.doesNotThrow(() => recordLlm({ provider: 'gemini', model: 'x', ok: true }));
});

/* ------------------------- Groq rate limits ----------------------------- */

test('groqRateLimits: maps Groq\'s real response shape, caches, and degrades to null on failure', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/rate_limits')) {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          data: [{
            id: 'openai/gpt-oss-120b',
            rate_limits: { rpdl: 14_400, remaining_rpdl: 12_050, tpd: 200_000, remaining_tpd: 150_000 },
          }],
        }),
      };
    }
    return realFetch(url);
  };
  try {
    const first = await groqRateLimits('gsk-test-key', ['openai/gpt-oss-120b']);
    assert.equal(first.length, 1);
    assert.equal(first[0].model, 'openai/gpt-oss-120b');
    assert.equal(first[0].requestsPerDay, 14_400);
    assert.equal(first[0].remainingRequests, 12_050);
    assert.equal(first[0].remainingTokens, 150_000);
    const second = await groqRateLimits('gsk-test-key', ['openai/gpt-oss-120b']);
    assert.equal(calls, 1, '5-minute module cache avoids hammering Groq');
    assert.equal(second[0].remainingRequests, 12_050);
    assert.equal(await groqRateLimits('', []), null, 'no key → null, never a lie');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ------------------------- health snapshot ------------------------------ */

test('llmHealthSnapshot: breaker state + 24h source split + per-model rows, no key material', async () => {
  await ChatbotSetting.updateOne(
    { key: 'global' },
    { $set: { aiOutageUntil: new Date(Date.now() + 5 * 60_000) } },
    { upsert: true }
  );
  await ChatbotLog.create({ question: 'q1', answer: 'a1', source: 'gemini' });
  await ChatbotLog.create({ question: 'q2', answer: 'a2', source: 'groq' });
  await ChatbotLog.create({ question: 'q3', answer: 'a3', source: 'fallback' });

  const snap = await llmHealthSnapshot({ groqKey: '', groqModels: [] });
  assert.equal(snap.breakerOpen, true);
  assert.ok(snap.aiOutageUntil, 'breaker expiry surfaced');
  assert.equal(snap.replies24h.total, 3);
  assert.equal(snap.replies24h.bySource.gemini, 1);
  assert.equal(snap.replies24h.bySource.groq, 1);
  assert.equal(snap.replies24h.bySource.fallback, 1);
  const gRow = snap.models.find((m) => m.provider === 'gemini');
  assert.ok(gRow, 'telemetry row surfaced');
  assert.equal(gRow.ok, 2);
  assert.equal(gRow.fail429, 1);
  assert.ok(gRow.lastError.length > 0, 'human-readable failure reason surfaced');
  assert.ok(!JSON.stringify(snap).includes('gsk-test-key'), 'never leaks keys');
  assert.ok(!JSON.stringify(snap).includes('test-gemini-key'), 'never leaks keys');

  // breaker expired → healthy again
  await ChatbotSetting.updateOne({ key: 'global' }, { $set: { aiOutageUntil: new Date(Date.now() - 1000) } });
  const snap2 = await llmHealthSnapshot({ groqKey: '', groqModels: [] });
  assert.equal(snap2.breakerOpen, false);
  assert.equal(snap2.aiOutageUntil, null);
});

/* ------------------------- admin route ---------------------------------- */

async function adminLogin() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'AdminPass123!456' }),
  });
  assert.equal(res.status, 200, 'admin login for health tests');
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

test('chatbot health: requires an admin session', async () => {
  const res = await fetch(`${BASE}/api/admin/chatbot/health`);
  assert.equal(res.status, 401);
});

test('chatbot health: admin sees today\'s usage rows + breaker + reasons', async () => {
  const adminCookie = await adminLogin();
  const res = await fetch(`${BASE}/api/admin/chatbot/health`, { headers: { cookie: adminCookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  const d = json.data;
  assert.ok(Array.isArray(d.models), 'per-model rows');
  assert.equal(typeof d.replies24h.total, 'number');
  assert.ok(Array.isArray(d.groqLimits), 'groq limits array (live or empty)');
  const gRow = d.models.find((m) => m.provider === 'gemini');
  assert.ok(gRow, 'gemini telemetry visible in the panel');
  assert.equal(gRow.ok, 2);
  assert.match(gRow.lastError, /429|timeout/i, 'the exact failure reason is surfaced');
});
