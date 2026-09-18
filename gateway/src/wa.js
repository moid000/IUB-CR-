import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const AUTH_DIR = join(process.cwd(), 'auth');

const logger = pino({ level: 'silent' }); // Baileys internal logs off; we print our own

let sock = null;
let connected = false;
let starting = false;

export function isWhatsAppConnected() {
  return connected;
}

export function getConnection() {
  return sock;
}

export function toJid(whatsappNumber) {
  // Normalizes any stored PK format (0301…, 92301…, +92…) to a WhatsApp JID
  let digits = String(whatsappNumber || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = `92${digits.slice(1)}`; // 0301… → 92301…
  if (digits.length === 10) digits = `92${digits}`; // 301… → 92301…
  return `${digits}@s.whatsapp.net`;
}

async function connect(onSweepTick) {
  if (starting) return;
  starting = true;
  connected = false;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1015901307]; // offline fallback
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Tri3M Gateway', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false, // do not show "online" status on your phone
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 WhatsApp QR — apne phone se scan karo:');
      console.log('(WhatsApp → Settings → Linked Devices → Link a Device)\n');
      qrcode.generate(qr, { small: true });
      console.log('\nQR ~20 second mein refresh hota hai — scan aasaani se kar lo.\n');
    }
    if (connection === 'open') {
      connected = true;
      starting = false;
      console.log(`✅ [${now()}] WhatsApp connected — deadline sweep ACTIVE`);
      onSweepTick?.(); // sweep immediately on connect
    }
    if (connection === 'close') {
      connected = false;
      starting = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log(`\n❌ [${now()}] Logged out (ya session invalid). Naya QR aa raha hai — dobara scan karo.\n`);
        if (existsSync(AUTH_DIR)) await rm(AUTH_DIR, { recursive: true, force: true });
        setTimeout(() => connect(onSweepTick), 3000);
      } else {
        console.log(`⚠️  [${now()}] Connection closed (${code}) — reconnecting in 5s…`);
        setTimeout(() => connect(onSweepTick), 5000);
      }
    }
  });
}

export async function startWhatsApp(onSweepTick) {
  await connect(onSweepTick);
}

export async function sendText(jid, text) {
  if (!sock || !connected) throw new Error('WhatsApp not connected');
  await sock.sendMessage(jid, { text });
}

/** Sends a real file as a WhatsApp document (the big upgrade over link-only sending). */
export async function sendDocument(jid, { buffer, fileName, mimetype, caption }) {
  if (!sock || !connected) throw new Error('WhatsApp not connected');
  await sock.sendMessage(jid, {
    document: buffer,
    fileName,
    mimetype,
    caption,
  });
}

export function now() {
  return new Intl.DateTimeFormat('en-PK', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date());
}
