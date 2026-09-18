export const maxDuration = 30;
import { connectMongo } from '../src/mongo.js';
import { authed, unauthorized } from '../src/gwsecrets.js';
import { WaStore } from '../src/models.js';

/**
 * DEBUG/ONE-TIME: import a Baileys session produced elsewhere (sandbox
 * pairing helper — scripts/pair-sandbox.mjs). The sandbox can reach
 * WhatsApp but NOT MongoDB, so pairing runs there with an in-memory auth
 * state, exports { creds, keys } as pre-serialized JSON strings (exactly
 * the wa_store doc format) and POSTs them here.
 *
 * Secret-gated (QR_SECRET). Replaces any existing wa_store contents.
 */
export default async function handler(req, res) {
  if (!authed(req, 'QR_SECRET')) return unauthorized(res);
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'POST only' }));
  }

  const { creds, keys } = req.body || {};
  if (typeof creds !== 'string' || !creds.includes('registered')) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'creds string missing' }));
  }

  try {
    await connectMongo();
    await WaStore.deleteMany({});
    await WaStore.findByIdAndUpdate('creds', { $set: { v: creds } }, { upsert: true });

    let count = 0;
    for (const [id, v] of Object.entries(keys || {})) {
      if (typeof v !== 'string' || !v) continue;
      if (!/^key-/.test(id)) continue; // doc ids must be key-<name>-<idx>
      await WaStore.findByIdAndUpdate(id, { $set: { v } }, { upsert: true });
      count += 1;
    }

    const saved = await WaStore.findById('creds').lean();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      keyDocs: count,
      credsRegistered: saved?.v?.includes('"registered":true') ?? false,
    }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}
