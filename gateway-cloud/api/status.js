export const maxDuration = 30;
import { connectMongo } from '../src/mongo.js';
import { authed, unauthorized } from '../src/gwsecrets.js';
import { isPaired } from '../src/sock.js';
import { WaStore } from '../src/models.js';

/** Gateway status JSON — used by the pair page poller and for live checks. */
export default async function handler(req, res) {
  if (!authed(req, 'QR_SECRET')) return unauthorized(res);
  try {
    await connectMongo();
    const paired = await isPaired();
    const meta = await WaStore.findById('meta-gateway').lean().catch(() => null);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      app: 'tri3m-whatsapp-gateway-serverless',
      paired,
      lastSweepAt: meta?.lastSweepAt ?? null,
      lastResult: meta?.lastResult ?? null,
      time: new Date().toISOString(),
    }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}
