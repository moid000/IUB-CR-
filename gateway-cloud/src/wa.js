import makeWASocket, {
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { useMongoAuthState } from './authState.js';

const logger = pino({ level: 'silent' });

let sock = null;
let connected = false;
let starting = false;
let lastQr = null;        // latest QR string (never leaves this module unauthenticated)
let lastQrDataUrl = null; // rendered PNG data URL for the secret QR page

export function isWhatsAppConnected() {
  return connected;
}
export function getStatus() {
  return { connected, hasQr: Boolean(lastQr), starting };
}
export function getQrDataUrl() {
  return lastQrDataUrl;
}

export function toJid(whatsappNumber) {
  let digits = String(whatsappNumber || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = `92${digits.slice(1)}`;
  if (digits.length === 10) digits = `92${digits}`;
  return `${digits}@s.whatsapp.net`;
}

export function now() {
  return new Intl.DateTimeFormat('en-PK', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date());
}

async function connect(onOpen) {
  if (starting) return;
  starting = true;
  connected = false;

  const { state, saveCreds, clearAll } = await useMongoAuthState();
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1015901307];
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Tri3M Gateway', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQr = qr;
      lastQrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
      console.log(`🔑 [${now()}] New QR ready — scan from the secret QR page`);
    }
    if (connection === 'open') {
      connected = true;
      starting = false;
      lastQr = null;
      lastQrDataUrl = null;
      console.log(`✅ [${now()}] WhatsApp connected — deadline sweep ACTIVE`);
      onOpen?.();
    }
    if (connection === 'close') {
      connected = false;
      starting = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log(`❌ [${now()}] Logged out — wiping stored session, fresh QR will be issued`);
        await clearAll();
        setTimeout(() => connect(onOpen), 3000);
      } else {
        console.log(`⚠️  [${now()}] Connection closed (${code}) — reconnecting in 5s…`);
        setTimeout(() => connect(onOpen), 5000);
      }
    }
  });
}

export async function startWhatsApp(onOpen) {
  await connect(onOpen);
}

export async function sendText(jid, text) {
  if (!sock || !connected) throw new Error('WhatsApp not connected');
  await sock.sendMessage(jid, { text });
}

export async function sendDocument(jid, { buffer, fileName, mimetype, caption }) {
  if (!sock || !connected) throw new Error('WhatsApp not connected');
  await sock.sendMessage(jid, { document: buffer, fileName, mimetype, caption });
}
