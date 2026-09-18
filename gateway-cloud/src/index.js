import 'dotenv/config';
import mongoose from 'mongoose';
import { startWhatsApp, isWhatsAppConnected, getStatus, getQrDataUrl, now } from './wa.js';
import { runSweep } from './sweep.js';
import { initServer, startServer } from './server.js';

/**
 * Tri3M WhatsApp Gateway — CLOUD edition (24/7, free, laptop-free).
 *
 * Same sweep engine as the laptop gateway (identical claim logic — the two
 * gateways + Vercel UltraMsg engine can never double-send), plus:
 * - Session stored in MongoDB → QR survives every restart/redeploy
 * - HTTP server: status JSON at / + secret QR page at /qr?key=…
 */

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const PORT = Number(process.env.PORT || 7860);
const QR_SECRET = process.env.QR_SECRET || '';
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI || !QR_SECRET) {
  console.error('❌ MONGODB_URI / QR_SECRET missing (host ke secrets/variables mein set karo).');
  process.exit(1);
}

let mongoReady = false;
let sweepRunning = false;
let lastSweepAt = null;

async function connectMongo() {
  while (!mongoReady) {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
      mongoReady = true;
      console.log(`✅ [${now()}] MongoDB connected`);
      await startWhatsApp(() => tick()); // session load needs Mongo, so WA starts after DB
    } catch (err) {
      console.log(`⚠️  [${now()}] MongoDB connect failed (${err.message}) — 10s retry`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

async function tick() {
  if (!mongoReady || !isWhatsAppConnected() || sweepRunning) return;
  sweepRunning = true;
  try {
    lastSweepAt = now();
    await runSweep();
  } catch (err) {
    console.log(`⚠️  [${now()}] sweep error: ${err.message}`);
  } finally {
    sweepRunning = false;
  }
}

// 1) HTTP server up FIRST (host health + QR page) — works even while DB retries
initServer({ secret: QR_SECRET, portNumber: PORT });
startServer(
  () => ({
    app: 'tri3m-whatsapp-gateway',
    connected: isWhatsAppConnected(),
    whatsapp: isWhatsAppConnected() ? 'connected' : getStatus().starting ? 'connecting' : 'disconnected',
    qrReady: getStatus().hasQr,
    mongo: mongoReady ? 'connected' : 'connecting',
    lastSweepAt,
    time: now(),
  }),
  () => getQrDataUrl()
);

console.log('════════════════════════════════════════════════');
console.log('  Tri3M WhatsApp Gateway — CLOUD (24/7, free)');
console.log(`  Status: http://localhost:${PORT}/  |  QR: /qr?key=***`);
console.log('════════════════════════════════════════════════');

await connectMongo();
setInterval(tick, POLL_SECONDS * 1000);
console.log(`⏱️  [${now()}] Polling every ${POLL_SECONDS}s`);
