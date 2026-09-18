import 'dotenv/config';
import mongoose from 'mongoose';
import { startWhatsApp, isWhatsAppConnected, now } from './wa.js';
import { runSweep } from './sweep.js';

/**
 * Tri3M WhatsApp Gateway — free, self-hosted (Baileys).
 *
 * Replaces UltraMsg. Runs on your own laptop:
 *   1. Connects to WhatsApp via QR (once) — session saved in ./auth
 *   2. Polls MongoDB Atlas every POLL_SECONDS for due assignment deadlines
 *   3. Sends teacher summary + per-student submissions with REAL file attachments
 *
 * Uses the SAME deadlineNotifiedAt claim as the Vercel engine, so the two
 * can never double-send. Laptop off at deadline? On next start it catches
 * up everything from the last 24h.
 */

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI missing — .env file banao (README dekho).');
  process.exit(1);
}

let mongoReady = false;
let sweepRunning = false;

async function connectMongo() {
  while (!mongoReady) {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
      mongoReady = true;
      console.log(`✅ [${now()}] MongoDB connected`);
    } catch (err) {
      console.log(`⚠️  [${now()}] MongoDB connect failed (${err.message}) — 10s mein retry`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

async function tick() {
  if (!mongoReady || !isWhatsAppConnected() || sweepRunning) return;
  sweepRunning = true;
  try {
    await runSweep();
  } catch (err) {
    console.log(`⚠️  [${now()}] sweep error: ${err.message}`);
  } finally {
    sweepRunning = false;
  }
}

function startPolling() {
  setInterval(tick, POLL_SECONDS * 1000);
  console.log(`⏱️  [${now()}] Polling every ${POLL_SECONDS}s — deadline ends pe teacher ko messages jayenge`);
}

console.log('════════════════════════════════════════════');
console.log('  Tri3M WhatsApp Gateway (free, self-hosted)');
console.log('════════════════════════════════════════════');

connectMongo(); // non-blocking — DB retries in background; WhatsApp QR turant aata hai
await startWhatsApp(() => tick()); // immediate sweep once WhatsApp connects
startPolling();

// Keep the process alive and informative
setInterval(() => {
  console.log(`💓 [${now()}] alive | WhatsApp: ${isWhatsAppConnected() ? 'connected' : 'connecting…'} | DB: ${mongoReady ? 'connected' : 'down'}`);
}, 10 * 60 * 1000);
