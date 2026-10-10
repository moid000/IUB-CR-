import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';

/**
 * WhatsApp delivery — WASENDER gateway implementation (2026-10-10 migration).
 *
 * CONTRACT: this module exports EXACTLY the same symbols with the same
 * signatures and return shapes as ultramsgGateway.js, so the facade
 * (whatsappService.js) can swap between them with zero caller changes.
 *
 * API notes (docs verified live 2026-10-10):
 *  - ONE endpoint for everything: POST {api}/send-message (JSON, Bearer auth)
 *  - text / image / video / audio / document are just parameters:
 *      { to, text }                     -> text message
 *      { to, text, imageUrl }           -> image (text = caption)
 *      { to, text, videoUrl }           -> video (text = caption)
 *      { to, audioUrl }                 -> audio
 *      { to, text, documentUrl, fileName } -> document (text = caption)
 *  - mentions: array of JIDs; body must contain "@<number>"
 *  - `to` accepts bare international digits, +E.164, JIDs and group JIDs
 *  - success: { success: true, data: { msgId, jid, status } }
 */

const SEND_TIMEOUT_MS = 20_000;

export function isConfigured() {
  return Boolean(env.wasender?.apiKey);
}

function base() {
  return String(env.wasender?.apiUrl || 'https://wasenderapi.com/api').replace(/\/+$/, '');
}

async function postJson(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${base()}${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${env.wasender.apiKey}`,
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON gateway response */ }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** Same low-level contract as the UltraMsg postForm (kept for tests/tools). */
export async function postForm(url, params) {
  // UltraMsg callers pass a form URL — Wasender ignores it and posts JSON.
  const res = await postJson('/send-message', { ...params });
  return res;
}

/**
 * Sends a text (or mention) message. Same contract as the UltraMsg version:
 * throws ApiError on gateway failure, returns a `{ sent: true, ... }` object on
 * success (Wasender's `success` flag is normalized to UltraMsg's `sent`).
 */
export async function sendText(to, body, mentioned = []) {
  if (!isConfigured()) {
    throw new ApiError(503, 'WhatsApp gateway is not configured');
  }
  const payload = { to: String(to ?? ''), text: String(body ?? '') };
  if (Array.isArray(mentioned) && mentioned.length) {
    payload.mentions = mentioned.map((m) => `${String(m).replace(/[^\d]/g, '')}@c.us`).filter((j) => j !== '@c.us');
  }
  const { ok, status, json } = await postJson('/send-message', payload);
  if (!ok || json?.success === false) {
    const detail = json?.message || `HTTP ${status}`;
    throw new ApiError(502, `WhatsApp send failed: ${detail}`);
  }
  return { sent: true, msgId: json?.data?.msgId ?? null, jid: json?.data?.jid ?? null };
}

/* --------------------------- media sends -------------------------------- */

async function sendMedia(kind, { to, url, caption, filename }) {
  if (!isConfigured()) {
    throw new ApiError(503, 'WhatsApp gateway is not configured');
  }
  const payload = { to: String(to ?? '') };
  if (kind === 'image') payload.imageUrl = url;
  else if (kind === 'video') payload.videoUrl = url;
  else if (kind === 'audio') payload.audioUrl = url;
  else if (kind === 'document') {
    payload.documentUrl = url;
    if (filename) payload.fileName = String(filename).slice(0, 255);
  }
  if (caption && kind !== 'audio') payload.text = String(caption).slice(0, 1024);
  const { ok, status, json } = await postJson('/send-message', payload);
  if (!ok || json?.success === false) {
    const detail = json?.message || `HTTP ${status}`;
    throw new ApiError(502, `WhatsApp send failed: ${detail}`);
  }
  return { sent: true, msgId: json?.data?.msgId ?? null };
}

/** Sends an image by PUBLIC URL (Cloudinary secure_urls work as-is). */
export function sendImage(to, imageUrl, caption) {
  return sendMedia('image', { to, url: imageUrl, caption });
}

/** Sends a document by URL with display filename + optional caption. */
export function sendDocument(to, url, filename, caption) {
  return sendMedia('document', { to, url, filename, caption });
}

/** Sends an audio file by URL — arrives as a playable audio message. */
export function sendAudio(to, url) {
  return sendMedia('audio', { to, url });
}

/** Sends a video file by URL. */
export function sendVideo(to, url, caption) {
  return sendMedia('video', { to, url, caption });
}

/**
 * Lists every WhatsApp group the paired number belongs to, with participants.
 * Wasender's group LIST carries no participants, so each group's participant
 * roster is fetched in parallel (capped) — the CR privacy filter needs it.
 * Same normalized return shape as the UltraMsg implementation.
 */
export async function listGroups() {
  if (!isConfigured()) {
    throw new ApiError(503, 'WhatsApp gateway is not configured');
  }
  const { ok, status, json } = await postJson('/groups');
  if (!ok || json?.success === false || !Array.isArray(json?.data)) {
    throw new ApiError(502, `WhatsApp groups fetch failed: ${json?.message || `HTTP ${status}`}`);
  }
  const groups = json.data
    .map((g) => ({ id: String(g?.id ?? ''), name: String(g?.name ?? g?.subject ?? (g?.id || 'Group')), participants: [] }))
    .filter((g) => g.id.endsWith('@g.us'));
  // fill participants (privacy filter depends on them) — parallel, cap 25
  const roster = await Promise.allSettled(
    groups.slice(0, 25).map((g) =>
      postJson(`/groups/${encodeURIComponent(g.id)}/participants`).then((r) => {
        if (!r.ok || r.json?.success === false) return [];
        const list = Array.isArray(r.json?.data) ? r.json.data : [];
        return list.map((p) => String(p?.pn ?? '').replace(/[^\d]/g, '')).filter(Boolean);
      })),
  );
  groups.forEach((g, i) => {
    const r = roster[i];
    if (r && r.status === 'fulfilled') g.participants = r.value;
  });
  return groups;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
