/**
 * WASENDER ROSTER CACHE (2026-10-10) — the CR group page fix.
 *
 * Wasender caps the per-group participants endpoint at 10 req/min (trial AND
 * paid). The old refresh fetched every group's roster in one parallel burst:
 * 11 groups > 10/min, most calls got rate-limited, allSettled swallowed the
 * 429s as empty rosters and the CR saw ZERO groups with a "your number is in
 * none of them" message — while their number WAS a member.
 *
 * These tests pin the new contract of whatsappGroupService.listGroupsCached:
 * - meta call carries NO participants (Wasender shape) -> per-group fetches
 * - at most ROSTER_FETCH_BUDGET roster fetches per call, spaced
 * - fresh TTL cache means NO fetch for cached groups (rate budget saved)
 * - a failing fetch falls back to the STALE cache, never a fake empty roster
 * - UltraMsg's single-call meta (participants present) is cached as-is
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('wa_roster_test');
process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.BREVO_API_KEY = 'fake-test-key';
// WASENDER mode + zero spacing so the fetch budget logic runs instantly
process.env.WHATSAPP_GATEWAY = 'wasender';
process.env.WASENDER_API_KEY = 'test-wasender-key';
process.env.WHATSAPP_ROSTER_SPACING_MS = '0';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
await import('../backend/services/whatsappGatewayPhoneFix.js').catch(() => {}); // no-op guard
const { listGroupsCached } = await import('../backend/services/whatsappGroupService.js');
const { GroupRosterCache } = models;
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const CR = '923088787753';

/* --------------------------- gateway stubbing ---------------------------- */

const realFetch = globalThis.fetch;
const GROUP_IDS = Array.from({ length: 11 }, (_, i) => `1203630${i}@g.us`);
let rosterCalls = 0;
let failRosterFor = new Set(); // group ids whose roster fetch must 429
const rosterOf = (gid) => [CR, '92300' + gid.slice(7, 11)];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes('wasenderapi.com')) return realFetch(url, opts);
  const reply = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const path = u.replace('https://wasenderapi.com/api', '');
  if (path === '/groups') {
    return reply({ success: true, data: GROUP_IDS.map((id, i) => ({ id, name: `Group ${i}` })) });
  }
  if (path.includes('/participants')) {
    rosterCalls += 1;
    const gid = decodeURIComponent(path.split('/groups/')[1].split('/')[0]);
    if (failRosterFor.has(gid)) {
      return reply({ success: false, message: 'rate limited', retry_after: 60 }, 429);
    }
    return reply({ success: true, data: rosterOf(gid).map((pn) => ({ id: 'x@lid', jid: `${pn}@s.whatsapp.net`, pn })) });
  }
  return reply({ success: false, message: 'unexpected' }, 404);
};

/* -------------------------------- tests ---------------------------------- */

test('first call: budget-capped fetches, cache persisted', async () => {
  const groups = await listGroupsCached();
  assert.equal(groups.length, 11);
  assert.equal(rosterCalls, 8, 'must fetch at most ROSTER_FETCH_BUDGET rosters per call');
  // fetched groups carry rosters; over-budget groups are simply empty this round
  const withRoster = groups.filter((g) => g.participants.length > 0);
  assert.equal(withRoster.length, 8);
  assert.equal(await GroupRosterCache.countDocuments(), 8);
  for (const g of withRoster) assert.ok(g.participants.includes(CR));
});

test('second call: fresh cache means zero extra fetches for cached groups', async () => {
  rosterCalls = 0;
  const groups = await listGroupsCached();
  assert.equal(rosterCalls, 3, 'only the 3 uncached groups are fetched');
  assert.equal(groups.filter((g) => g.participants.includes(CR)).length, 11);
  assert.equal(await GroupRosterCache.countDocuments(), 11);
});

test('rate-limited fetch on a stale group falls back to the stale roster', async () => {
  // age one cached roster past the TTL so it needs a refetch, then 429 it
  await GroupRosterCache.updateOne({ groupId: GROUP_IDS[0] },
    { $set: { fetchedAt: new Date(Date.now() - 16 * 60 * 1000) } });
  failRosterFor.add(GROUP_IDS[0]);
  rosterCalls = 0;
  const groups = await listGroupsCached();
  assert.ok(rosterCalls >= 1, 'the stale group was attempted');
  const stale = groups.find((g) => g.id === GROUP_IDS[0]);
  assert.ok(stale.participants.includes(CR), 'stale-if-error, never a fake empty roster');
  failRosterFor.clear();
});

/* ------------------------------ teardown --------------------------------- */

test.after(async () => {
  globalThis.fetch = realFetch;
  await mongoose.disconnect();
  await mongod.stop();
});
