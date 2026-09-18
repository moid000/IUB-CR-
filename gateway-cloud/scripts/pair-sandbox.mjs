/**
 * SANDBOX PAIRING HELPER (one-time use, run from gateway-cloud/).
 *
 * Why this exists: Vercel serverless functions die after 60s, which makes
 * the web pairing page a race ("code expired" / "check your number"). The
 * sandbox CAN reach WhatsApp (wss 443) but NOT MongoDB (27017), so:
 *   1. This script opens a Baileys socket with an IN-MEMORY auth state.
 *   2. It writes the QR to pair-qr.png and requests ONE pairing code for
 *      the owner's number (argv[2]) — exactly once per session, because a
 *      new code request INVALIDATES the previous code mid-typing.
 *   3. On success ('open'), the session is snapshotted to pair-session.json
 *      in the EXACT wa_store serialization (BufferJSON.replacer) and
 *      auto-imported into the cloud gateway via /api/import-session.
 *
 * Usage: node scripts/pair-sandbox.mjs [whatsapp-number-for-pairing-code]
 */
import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  fetchLatestBaileysVersion,
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const logger = pino({ level: 'silent' });

const ROOT = path.resolve(import.meta.dirname, '..');
const QR_PNG = path.join(ROOT, '..', 'pair-qr.png');
const SNAPSHOT = path.join(ROOT, '..', 'pair-session.json');

let lastCodeAt = 0;
let creds = initAuthCreds();
const keys = new Map(); // doc-id -> serialized value string

function snapshot() {
  const payload = {
    creds: JSON.stringify(creds, BufferJSON.replacer),
    keys: Object.fromEntries(keys),
  };
  fs.writeFileSync(SNAPSHOT, JSON.stringify(payload));
}

const state = {
  creds,
  keys: {
    get: async (key, idx) => {
      const raw = keys.get(`key-${key}-${idx}`);
      if (raw === undefined) return null;
      return JSON.parse(raw, BufferJSON.reviver);
    },
    set: async (key, idx, value) => {
      if (value === undefined || value === null) return;
      keys.set(`key-${key}-${idx}`, JSON.stringify(value, BufferJSON.replacer));
      snapshot();
    },
  },
};

function now() {
  return new Intl.DateTimeFormat('en-PK', { timeZone: 'Asia/Karachi', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
}

async function run() {
  const phoneArg = process.argv[2];
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1015901307];
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Tri3M Gateway', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', () => {
    creds = state.creds; // Baileys mutates state.creds in place
    snapshot();
  });

  const push = async (obj) => {
    try {
      await fetch(`https://iubcr-gateway.vercel.app/api/live-code?key=${process.env.QR_SECRET}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(obj),
      });
    } catch (e) {
      console.log(`push failed: ${e.message}`);
    }
  };

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      await QRCode.toFile(QR_PNG, qr, { width: 480, margin: 2 });
      console.log(`🔑 [${now()}] QR saved → pair-qr.png`);
      await push({ qr: qrDataUrl });
      // Codes age out with the socket; re-request when the current one is
      // older than 25s (roughly every rotation) and push it to the live page.
      if (phoneArg && Date.now() - lastCodeAt > 25000) {
        try {
          const code = await sock.requestPairingCode(phoneArg);
          lastCodeAt = Date.now();
          console.log(`PAIRING_CODE: ${code}`);
          await push({ code, at: Date.now() });
        } catch (err) {
          console.log(`pairing code FAILED: ${err.message}`);
        }
      }
    }
    if (connection === 'open') {
      creds = state.creds;
      snapshot();
      console.log(`PAIRED at ${now()} — snapshot written to pair-session.json`);
      try {
        const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
        const r = await fetch(
          `https://iubcr-gateway.vercel.app/api/import-session?key=${process.env.QR_SECRET}`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snap) }
        );
        const j = await r.json().catch(() => ({}));
        console.log(`IMPORT_RESULT: ${r.status} ${JSON.stringify(j)}`);
      } catch (e) {
        console.log(`IMPORT_FAILED: ${e.message}`);
      }
      setTimeout(() => process.exit(0), 1500);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log(`❌ [${now()}] Logged out (code ${code}). Restart the script for a fresh session.`);
        process.exit(1);
      }
      console.log(`⚠️  [${now()}] closed (${code}) — supervisor will restart`);
      setTimeout(() => process.exit(42), 100);
    }
  });
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
