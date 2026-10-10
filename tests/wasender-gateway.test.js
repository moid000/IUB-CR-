/**
 * WASENDER GATEWAY TESTS (2026-10-10 migration).
 *
 * Everything the Wasender migration changed, tested against a stubbed
 * wasenderapi.com — plus proof that the UltraMsg path is byte-identical when
 * the gateway flag is 'ultramsg' (default).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { MongoMemoryReplSet } = await import('mongodb-memory-server');

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('wasender_test');
process.env.JWT_SECRET = 'test-wasender-jwt';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.ULTRAMSG_INSTANCE_ID = 'instance138500';
process.env.ULTRAMSG_TOKEN = 'ultramsg-token';
process.env.ULTRAMSG_WEBHOOK_SECRET = 'fake-webhook-secret';
process.env.DEADLINE_SWEEP_SECRET = 'fake-sweep-secret';
process.env.GOOGLE_API_KEY = 'test-key';
process.env.ALLOW_TEST_GEMINI = '1';
process.env.CLOUDINARY_CLOUD_NAME = 'demo';
process.env.CLOUDINARY_API_KEY = 'key';
process.env.CLOUDINARY_API_SECRET = 'secret';
// gateway under test
process.env.WHATSAPP_GATEWAY = 'wasender';
process.env.WASENDER_API_KEY = 'test-wasender-key';

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { env } = await import('../backend/config/env.js');
const wasender = await import('../backend/services/wasenderGateway.js');
const { normalizeIncomingPayload, isWasenderPayload } = await import('../backend/services/wasenderPayload.js');
const { sendTracked, retryOutbox } = await import('../backend/services/whatsappService.js');
const { OutboxMessage } = models;

await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));

const realFetch = globalThis.fetch;
const wasenderCalls = []; // every Wasender API call {path, body}
let failNextSend = false;

globalThis.fetch = (url, options = {}) => {
  const u = String(url);
  if (u.includes('wasenderapi.com/api')) {
    const path = u.replace('https://wasenderapi.com/api', '');
    const body = options.body ? JSON.parse(options.body) : null;
    const reply = (obj) => Promise.resolve(new Response(JSON.stringify(obj), { status: 200 }));
    if (u.endsWith('/status')) return reply({ status: 'connected' });
    if (u.endsWith('/send-message')) {
      wasenderCalls.push({ path, body });
      if (failNextSend) { failNextSend = false; return reply({ success: false, message: 'gateway down' }); }
      return reply({ success: true, data: { msgId: 100, jid: body?.to, status: 'in_progress' } });
    }
    if (path === '/groups') {
      wasenderCalls.push({ path });
      return reply({ success: true, data: [
        { id: '120363AAA@g.us', name: 'Testing group' },
        { id: '120363BBB@g.us', name: 'CS 4B class' }] });
    }
    if (path.includes('/participants')) {
      wasenderCalls.push({ path });
      const gid = decodeURIComponent(path.split('/groups/')[1].split('/')[0]);
      return reply({ success: true, data: [
        { id: '1@lid', jid: '923009876543@s.whatsapp.net', pn: '923009876543' },
        { id: '2@lid', jid: '923005556667@s.whatsapp.net', pn: '923005556667' }] });
    }
    if (u.endsWith('/decrypt-media')) {
      wasenderCalls.push({ path, body });
      return reply({ success: true, data: { publicUrl: `https://media.wasender.test/decrypted-${body?.data?.messages?.key?.id ?? 'x'}` } });
    }
    return reply({ success: true, data: {} });
  }
  if (u.includes('api.ultramsg.com')) {
    wasenderCalls.push({ path: `ULTRAMSG-STUB ${u}` });
    return Promise.resolve(new Response(JSON.stringify({ sent: true }), { status: 200 }));
  }
  return realFetch(url, options);
};

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const webhook = (body, headers = {}) => fetch(`${base}/api/whatsapp/teacher-reply`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-signature': 'fake-webhook-secret', ...headers },
  body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));

const wasenderText = (text, from = '923001112233') => ({
  event: 'messages.received', timestamp: Math.floor(Date.now() / 1000),
  data: { messages: {
    key: { id: `W-${Math.random().toString(36).slice(2)}`, fromMe: false, remoteJid: `${from}@s.whatsapp.net`, cleanedSenderPn: from },
    messageBody: text, message: { conversation: text } } },
});

test.after(async () => {
  await mongoose.disconnect();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  await mongod.stop();
});

test('sendText: JSON + Bearer + mentions mapped to @c.us JIDs; sent:true normalized', async () => {
  const res = await wasender.sendText('923009876543', 'Hello @923001112233 aap ka jawab', ['923001112233']);
  assert.equal(res.sent, true);
  const call = wasenderCalls.find((c) => c.path === '/send-message' && c.body?.mentions);
  assert.ok(call, 'mentions call made');
  assert.equal(call.body.to, '923009876543');
  assert.deepEqual(call.body.mentions, ['923001112233@c.us']);
});

test('sendText: gateway failure throws ApiError 502 with the vendor message', async () => {
  failNextSend = true;
  await assert.rejects(() => wasender.sendText('923001112233', 'fail me'), (err) => err.statusCode === 502 && /gateway down/.test(err.message));
});

test('media sends: image/video/audio/document parameters + caption/fileName', async () => {
  await wasender.sendImage('923001112233', 'https://cdn.example/a.png', 'caption text');
  await wasender.sendVideo('923001112233', 'https://cdn.example/a.mp4', 'vid caption');
  await wasender.sendAudio('923001112233', 'https://cdn.example/a.ogg');
  await wasender.sendDocument('923001112233', 'https://cdn.example/a.pdf', 'Lecture_3.pdf', 'the doc text');
  const calls = wasenderCalls.filter((c) => c.path === '/send-message' && c.body?.to === '923001112233');
  assert.ok(calls.some((c) => c.body.imageUrl === 'https://cdn.example/a.png' && c.body.text === 'caption text'));
  assert.ok(calls.some((c) => c.body.videoUrl && c.body.text === 'vid caption'));
  assert.ok(calls.some((c) => c.body.audioUrl && c.body.text === undefined));
  assert.ok(calls.some((c) => c.body.documentUrl && c.body.fileName === 'Lecture_3.pdf' && c.body.text === 'the doc text'));
});

test('listGroups: roster fetched per group, digits-only participants', async () => {
  const groups = await wasender.listGroups();
  assert.equal(groups.length, 2);
  const testing = groups.find((g) => g.name === 'Testing group');
  assert.ok(testing.id.endsWith('@g.us'));
  assert.deepEqual(testing.participants, ['923009876543', '923005556667']);
});

test('normalizer: private text payload -> exact UltraMsg shape', async () => {
  const p = await normalizeIncomingPayload(wasenderText('YES'));
  assert.equal(isWasenderPayload(wasenderText('x')), true);
  assert.equal(p.event_type, 'message_received');
  assert.equal(p.data.from, '923001112233@c.us');
  assert.equal(p.data.body, 'YES');
  assert.equal(p.data.type, 'chat');
  assert.equal(p.data.fromMe, false);
  assert.ok(p.data.id);
});

test('normalizer: group payload -> author from cleanedParticipantPn', async () => {
  const g = { event: 'messages.received', timestamp: 1,
    data: { messages: {
      key: { id: 'G1', fromMe: false, remoteJid: '120363AAA@g.us', cleanedParticipantPn: '923009876543' },
      messageBody: '@Tri3M who is the CR?', message: { conversation: '@Tri3M who is the CR?' } } } };
  const p = await normalizeIncomingPayload(g);
  assert.equal(p.data.from, '120363AAA@g.us');
  assert.equal(p.data.author, '923009876543@c.us');
});

test('normalizer: document media -> decrypt-media called, media/mediaUrl/filename/caption populated', async () => {
  const d = { event: 'messages.received', timestamp: 1,
    data: { messages: {
      key: { id: 'D1', fromMe: false, remoteJid: '923001112233@s.whatsapp.net', cleanedSenderPn: '923001112233' },
      messageBody: 'notes attached', message: { documentMessage: {
        url: 'https://mmg.whatsapp.net/encrypted.bin', mimetype: 'application/pdf',
        fileName: 'Lecture_4.pdf', caption: 'notes attached' } } } } };
  const p = await normalizeIncomingPayload(d);
  assert.equal(p.data.type, 'document');
  assert.equal(p.data.filename, 'Lecture_4.pdf');
  assert.equal(p.data.caption, 'notes attached');
  assert.equal(p.data.mimetype, 'application/pdf');
  assert.ok(p.data.media.startsWith('https://media.wasender.test/decrypted-'), 'media is the DECRYPTED publicUrl');
  assert.equal(p.data.mediaUrl, p.data.media);
  assert.ok(wasenderCalls.some((c) => c.path === '/decrypt-media'));
});

test('normalizer: ptt voice note -> type ptt; regular audio -> audio', async () => {
  const mk = (ptt) => ({ event: 'messages.received', timestamp: 1,
    data: { messages: { key: { id: `V-${ptt}`, fromMe: false, remoteJid: '923001112233@s.whatsapp.net', cleanedSenderPn: '923001112233' },
      messageBody: '', message: { audioMessage: { url: 'https://x/b.bin', mimetype: 'audio/ogg', ptt } } } } });
  assert.equal((await normalizeIncomingPayload(mk(true))).data.type, 'ptt');
  assert.equal((await normalizeIncomingPayload(mk(false))).data.type, 'audio');
});

test('outbox (sendTracked/retryOutbox) routes through the ACTIVE gateway', async () => {
  await OutboxMessage.deleteMany({});
  const r = await sendTracked('923001112233', 'outbox via wasender', { kind: 'material' });
  assert.equal(r.sent, true);
  assert.ok(wasenderCalls.some((c) => c.path === '/send-message' && c.body?.text === 'outbox via wasender'));
  failNextSend = true;
  const r2 = await sendTracked('923001112233', 'this one fails', { kind: 'material' });
  assert.equal(r2.sent, false);
  const row = await OutboxMessage.findOne({ status: 'failed' }).lean();
  assert.ok(row, 'failed row persisted');
  await OutboxMessage.updateOne({ _id: row._id }, { $set: { lastTriedAt: new Date(Date.now() - 6 * 60 * 1000) } });
  const retry = await retryOutbox();
  assert.ok(retry.delivered >= 1, 'sweep re-delivered through Wasender');
});

test('E2E webhook: Wasender payload + x-webhook-signature header -> full pipeline answers through Wasender', async () => {
  const before = wasenderCalls.filter((c) => c.path === '/send-message').length;
  // unknown number greeting -> Tri3M welcome via the Wasender adapter
  const r = await webhook(wasenderText('Assalam o Alaikum', '923999555000'));
  assert.equal(r.status, 200);
  assert.equal(r.json.data.updated, true, 'normalized payload consumed');
  const after = wasenderCalls.slice(before).filter((c) => c.path === '/send-message');
  assert.ok(after.some((c) => c.body?.to === '923999555000' && /Tri3M Class Agent/.test(c.body?.text ?? '')),
    'welcome delivered through the Wasender API');
});

test('E2E webhook: wrong signature rejected (401) — secret guard covers both gateways', async () => {
  const r = await webhook(wasenderText('hi'), { 'x-webhook-signature': 'wrong' });
  assert.equal(r.status, 401);
});

test('UltraMsg payloads PASS THROUGH unchanged — byte-identical legacy path', async () => {
  const legacy = { event_type: 'message_received', instanceId: 'instance138500',
    data: { id: 'U1', from: '923001112233@c.us', fromMe: false, type: 'chat', body: 'ok', time: 1 } };
  const p = await normalizeIncomingPayload(legacy);
  assert.equal(p, legacy, 'same object identity — zero transformation');
  assert.equal(isWasenderPayload(legacy), false);
});

test('gateway flag flip: env.whatsapp.gateway=ultramsg routes sends to UltraMsg (rollback in one variable)', async () => {
  const saved = env.whatsapp.gateway;
  env.whatsapp.gateway = 'ultramsg';
  try {
    const res = await (await import('../backend/services/whatsappService.js')).sendText('923001112233', 'rollback test');
    assert.equal(res.sent, true);
    assert.ok(wasenderCalls.some((c) => c.path && c.path.startsWith('ULTRAMSG-STUB')), 'hit the UltraMsg stub');
    assert.ok(!wasenderCalls.slice(-3).some((c) => c.path === '/send-message' && c.body?.text === 'rollback test'));
  } finally {
    env.whatsapp.gateway = saved;
  }
});

test('watchdog wasender branch: connected session -> quiet success + state updated', async () => {
  const { WatchdogState, OutboxMessage } = models;
  await WatchdogState.deleteMany({});
  const wd = await import('../backend/services/ultramsgWatchdogService.js');
  const saved = env.whatsapp.gateway;
  env.whatsapp.gateway = 'wasender';
  try {
    const r = await wd.runWatchdog();
    assert.equal(r.gateway, 'wasender');
    assert.equal(r.status, 'connected');
    const last = await WatchdogState.findOne({ key: 'watchdog:last-run' }).lean();
    assert.ok(last, 'heartbeat recorded');
    const renew = await WatchdogState.findOne({ key: 'watchdog:last-renewal' }).lean();
    assert.equal(renew?.value, 'wasender:connected');
    // no alert state created on success
    const alert = await WatchdogState.findOne({ key: 'watchdog:wasender-session' }).lean();
    assert.equal(alert, null);
  } finally {
    env.whatsapp.gateway = saved;
  }
});

test('watchdog wasender branch: disconnected session -> alert state + error record', async () => {
  const { WatchdogState } = models;
  await WatchdogState.deleteMany({});
  const wd = await import('../backend/services/ultramsgWatchdogService.js');
  const saved = env.whatsapp.gateway;
  env.whatsapp.gateway = 'wasender';
  // make /api/status report a disconnect
  const inner = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => {
    if (String(url).endsWith('/status')) {
      return Promise.resolve(new Response(JSON.stringify({ status: 'disconnected' }), { status: 200 }));
    }
    return inner(url, options);
  };
  try {
    const r = await wd.runWatchdog();
    assert.equal(r.gateway, 'wasender');
    assert.equal(r.status, 'disconnected');
    assert.ok(r.alerted !== undefined, 'alert attempt recorded');
    const err = await WatchdogState.findOne({ key: 'watchdog:last-extend-error' }).lean();
    assert.ok(err && /wasender session/.test(err.value), 'error state persisted for the dashboard');
    const alert = await WatchdogState.findOne({ key: 'watchdog:wasender-session' }).lean();
    assert.ok(alert, 'throttle state created so repeats stay quiet');
  } finally {
    globalThis.fetch = inner;
    env.whatsapp.gateway = saved;
  }
});

test('normalizer: DOC-EXACT group event (messages-group.received) normalizes correctly', async () => {
  // verbatim shape from Wasender docs: Webhook: Group Message Received
  const doc = { event: 'messages-group.received', timestamp: 1633456799,
    data: { messages: {
      key: { id: 'message-id-group-456', fromMe: false, remoteJid: '123456789-987654321@g.us',
        participant: '123456789@lid', participantPn: '123456789@s.whatsapp.net',
        cleanedParticipantPn: '123456789', participantLid: '123456789@lid', addressingMode: 'lid' },
      messageBody: 'Hey everyone, just checking in!',
      message: { conversation: 'Hey everyone, just checking in!' } } } };
  assert.equal(isWasenderPayload(doc), true);
  const p = await normalizeIncomingPayload(doc);
  assert.equal(p.data.from, '123456789-987654321@g.us');
  assert.equal(p.data.author, '123456789@c.us');
  assert.equal(p.data.body, 'Hey everyone, just checking in!');
  assert.equal(p.data.type, 'chat');
});
