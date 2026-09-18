export const maxDuration = 30;
import { connectMongo } from '../src/mongo.js';
import { authed, unauthorized } from '../src/gwsecrets.js';
import { WaStore } from '../src/models.js';

/**
 * LIVE pairing-code relay.
 *
 * The sandbox pairing helper (scripts/pair-sandbox.mjs) holds the real
 * WhatsApp socket but can't show the owner anything. Every time it has a
 * fresh pairing code (or QR), it POSTs it here. The pair page polls this
 * endpoint every 3s and always shows the CURRENT code — killing the
 * "code expired by the time you read it in chat" race.
 *
 * GET  ?key=QR_SECRET  → { code, at, qr, ageSec }
 * POST ?key=QR_SECRET  → save { code, at, qr }   (from the sandbox helper)
 */
const DOC_ID = 'live-code';

export default async function handler(req, res) {
  if (!authed(req, 'QR_SECRET')) return unauthorized(res);
  res.setHeader('content-type', 'application/json');

  try {
    await connectMongo();

    if (req.method === 'POST') {
      const { code, at, qr } = req.body || {};
      if (!code && !qr) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'code or qr required' }));
      }
      const doc = await WaStore.findById(DOC_ID).lean();
      const prev = doc?.v ? JSON.parse(doc.v) : {};
      await WaStore.findByIdAndUpdate(
        DOC_ID,
        { $set: { v: JSON.stringify({ ...prev, ...(code ? { code, at: at || Date.now() } : {}), ...(qr ? { qr } : {}) }) } },
        { upsert: true }
      );
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET
    const doc = await WaStore.findById(DOC_ID).lean();
    if (!doc?.v) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ code: null, at: null, qr: null, ageSec: null }));
    }
    const { code, at, qr } = JSON.parse(doc.v);
    res.statusCode = 200;
    res.end(JSON.stringify({ code, at, qr, ageSec: at ? Math.round((Date.now() - at) / 1000) : null }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}
