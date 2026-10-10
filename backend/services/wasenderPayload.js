import { env } from '../config/env.js';

/**
 * Wasender → UltraMsg payload NORMALIZER (2026-10-10 migration).
 *
 * Wasender's webhook payload (event "messages.received") has a different shape
 * from UltraMsg's (event_type "message_received"). Rather than touching ANY
 * business logic, the webhook route converts incoming Wasender payloads into
 * the exact shape the pipeline already understands. Non-Wasender payloads pass
 * through UNTOUCHED — the live UltraMsg path stays byte-identical.
 *
 * Field mapping (docs verified live 2026-10-10):
 *   key.id                -> data.id            (idempotency / dedupe)
 *   key.fromMe            -> data.fromMe
 *   key.remoteJid         -> data.from          (private: pn jid; group: @g.us)
 *   key.cleanedSenderPn   -> private sender digits
 *   key.cleanedParticipantPn -> group author digits -> data.author
 *   messageBody           -> data.body
 *   message.conversation  -> type 'chat'
 *   message.imageMessage  -> type 'image'   (+caption, +decrypt url)
 *   message.videoMessage  -> type 'video'   (+caption, +decrypt url)
 *   message.documentMessage -> type 'document' (+fileName, +caption, +url)
 *   message.audioMessage  -> type 'ptt'|'audio' (voice-note gate)
 *   message.stickerMessage-> type 'sticker'
 *   raw.timestamp         -> data.time / data.timestamp
 *
 * WhatsApp media is encrypted at rest; Wasender exposes POST /api/decrypt-media
 * which returns a temporary publicUrl (1h). For every media message we decrypt
 * here and expose the plain URL via data.media AND data.mediaUrl — the same
 * fields the UltraMsg flow already populated, so findMediaUrl() and the
 * download/classify path work unchanged.
 */

const SEND_TIMEOUT_MS = 30_000;

export function isWasenderPayload(payload) {
  const p = payload ?? {};
  // 'messages-group.received' is Wasender's SEPARATE group-message event (its
  // payload shape is identical to messages.received but always carries the
  // group remoteJid + participant identity) — both must normalize.
  return p?.event === 'messages.received'
    || p?.event === 'messages-group.received'
    || (p?.event === 'messages.upsert' && p?.data?.messages)
    || Boolean(p?.data?.messages?.key && p?.data?.messages?.messageBody !== undefined);
}

const MEDIA_KINDS = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['documentMessage', 'document'],
  ['audioMessage', 'audio'],
  ['stickerMessage', 'sticker'],
];

function pickMedia(message) {
  for (const [k, kind] of MEDIA_KINDS) {
    if (message?.[k]) return { kind, raw: message[k] };
  }
  return null;
}

async function decryptMediaUrl(message) {
  const media = pickMedia(message);
  if (!media) return { url: null, mimetype: null, filename: null, caption: null };
  const { kind, raw } = media;
  const mimetype = raw?.mimetype ?? null;
  const filename = raw?.fileName ?? raw?.filename ?? null;
  const caption = raw?.caption ?? null;
  // The raw `url` points at WhatsApp's ENCRYPTED media store — usable only as
  // a last-ditch fallback. The primary path is the decrypt-media endpoint,
  // which returns a 1-hour publicUrl.
  const fallback = typeof raw?.url === 'string' && /^https?:\/\//.test(raw.url) ? raw.url : null;
  try {
    const base = String(env.wasender?.apiUrl || 'https://wasenderapi.com/api').replace(/\/+$/, '');
    const res = await fetch(`${base}/decrypt-media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.wasender.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data: { messages: { message } } }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    const publicUrl = json?.data?.publicUrl ?? json?.data?.url ?? json?.publicUrl ?? null;
    if (res.ok && publicUrl && /^https?:\/\//.test(publicUrl)) {
      return { url: publicUrl, mimetype, filename, caption };
    }
    console.error(`[wasender] decrypt-media failed (HTTP ${res.status}): ${String(text).slice(0, 200)}`);
  } catch (err) {
    console.error('[wasender] decrypt-media error:', String(err?.message ?? err).slice(0, 200));
  }
  return { url: fallback, mimetype, filename, caption };
}

/**
 * Converts a Wasender webhook payload into the UltraMsg payload shape.
 * Returns a NEW object — the original is never mutated.
 */
export async function normalizeWasenderPayload(raw) {
  const m = raw?.data?.messages ?? {};
  const key = m?.key ?? {};
  const message = m?.message ?? {};
  const remoteJid = String(key?.remoteJid ?? '');
  const isGroup = remoteJid.endsWith('@g.us');

  // sender identity — always prefer the CLEANED phone numbers (remoteJid may
  // be a LID that does not resolve to a phone)
  let from;
  let author = null;
  if (isGroup) {
    from = remoteJid;
    const participantPn = key?.cleanedParticipantPn
      ?? String(key?.participant ?? key?.participantPn ?? '').replace(/[^\d]/g, '');
    if (participantPn) author = `${String(participantPn).replace(/[^\d]/g, '')}@c.us`;
  } else {
    const pn = key?.cleanedSenderPn ?? String(remoteJid).split('@')[0].replace(/[^\d]/g, '');
    from = pn ? `${pn}@c.us` : remoteJid;
  }

  const media = pickMedia(message);
  let type = 'chat';
  if (media) {
    if (media.kind === 'audio') type = media.raw?.ptt ? 'ptt' : 'audio';
    else type = media.kind;
  }

  const out = {
    event_type: 'message_received',
    instanceId: env.whatsapp?.instanceId ?? null,
    data: {
      id: String(key?.id ?? ''),
      from,
      fromMe: Boolean(key?.fromMe),
      type,
      body: String(m?.messageBody ?? ''),
      time: Number(raw?.timestamp ?? Math.floor(Date.now() / 1000)),
      timestamp: Number(raw?.timestamp ?? Math.floor(Date.now() / 1000)),
    },
  };
  if (author) out.data.author = author;

  if (media) {
    const { url, mimetype, filename, caption } = await decryptMediaUrl(message);
    if (url) {
      out.data.media = url;
      out.data.mediaUrl = url;
    }
    if (mimetype) out.data.mimetype = mimetype;
    if (filename) out.data.filename = String(filename).slice(0, 255);
    if (caption) out.data.caption = String(caption).slice(0, 1024);
  }
  return out;
}

/** Route entry helper: pass-through for UltraMsg, conversion for Wasender. */
export async function normalizeIncomingPayload(payload) {
  if (!isWasenderPayload(payload)) return payload;
  return normalizeWasenderPayload(payload);
}
