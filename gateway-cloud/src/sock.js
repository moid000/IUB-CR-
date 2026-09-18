import makeWASocket, { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import { useMongoAuthState } from './authState.js';
import { WaStore } from './models.js';

const logger = pino({ level: 'silent' });

/**
 * One-shot WhatsApp socket for SERVERLESS functions.
 *
 * Unlike src/wa.js (long-running module state for the always-on gateway),
 * this opens a FRESH socket per invocation using the Mongo-persisted session
 * (authState.js), so the pairing survives forever across cold starts.
 */

export async function isPaired() {
  const doc = await WaStore.findById('creds').lean().catch(() => null);
  if (!doc) return false;
  try {
    const creds = JSON.parse(doc.v);
    return Boolean(creds.registered);
  } catch {
    return false;
  }
}

export async function openSocket() {
  const { state, saveCreds, clearAll } = await useMongoAuthState();
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

  sock.ev.on('creds.update', saveCreds);

  const events = { connected: false, closed: false, reason: null, qr: null };

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) events.qr = qr;
    if (connection === 'open') {
      events.connected = true;
    }
    if (connection === 'close') {
      events.connected = false;
      events.closed = true;
      events.reason = lastDisconnect?.error?.output?.statusCode ?? null;
    }
  });

  return {
    sock,
    events,
    clearAll,
    creds: state.creds, // mutated in place by Baileys when pairing succeeds
    isRegistered: () => Boolean(state.creds?.registered) || Boolean(sock.user),
    end: () => {
      try { sock.end(new Error('serverless invocation done')); } catch { /* noop */ }
    },
  };
}

/** Wait until predicate() is truthy or timeout ms pass. */
export function waitFor(predicate, { timeoutMs = 20000, everyMs = 250 } = {}) {
  const start = Date.now();
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (predicate()) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(t);
        resolve(false);
      }
    }, everyMs);
  });
}

/** Sender adapter: uses THIS invocation's socket. */
export function senderFrom(sock) {
  return {
    sendText: async (jid, text) => {
      if (!sock.user) throw new Error('WhatsApp not connected');
      await sock.sendMessage(jid, { text });
    },
    sendDocument: async (jid, { buffer, fileName, mimetype, caption }) => {
      if (!sock.user) throw new Error('WhatsApp not connected');
      await sock.sendMessage(jid, { document: buffer, fileName, mimetype, caption });
    },
  };
}
