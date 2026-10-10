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
 * Group LIST only — NO participants. Wasender's group list endpoint is
 * cheaply rate-limited, but its per-group participants endpoint is capped at
 * 10 requests/min (trial AND paid), so roster fetches are budgeted and
 * DB-cached by the caller (whatsappGroupService.listGroupsCached). This
 * split mirrors the UltraMsg contract through the facade fallback.
 * NOTE: returns {id, name} WITHOUT a participants field — the presence of
 * participants on the meta objects is how the service detects the
 * single-call UltraMsg roster shape.
 */
export async function listGroupMeta() {
  if (!isConfigured()) {
    throw new ApiError(503, 'WhatsApp gateway is not configured');
  }
  const { ok, status, json } = await postJson('/groups');
  if (!ok || json?.success === false || !Array.isArray(json?.data)) {
    throw new ApiError(502, `WhatsApp groups fetch failed: ${json?.message || `HTTP ${status}`}`);
  }
  return json.data
    .map((g) => ({ id: String(g?.id ?? ''), name: String(g?.name ?? g?.subject ?? (g?.id || 'Group')) }))
    .filter((g) => g.id.endsWith('@g.us'));
}

/**
 * One group's participant roster as bare intl digit strings (same shape the
 * UltraMsg listGroups put in group.participants). Throws on failure so the
 * caller's stale-cache fallback can engage — a rate-limited fetch must NEVER
 * silently look like an empty roster.
 */
export async function getGroupParticipants(groupId) {
  if (!isConfigured()) {
    throw new ApiError(503, 'WhatsApp gateway is not configured');
  }
  const id = String(groupId ?? '');
  if (!id.endsWith('@g.us')) throw new ApiError(400, 'Invalid WhatsApp group id');
  const { ok, status, json } = await postJson(`/groups/${encodeURIComponent(id)}/participants`);
  if (!ok || json?.success === false || !Array.isArray(json?.data)) {
    throw new ApiError(502, `Group participants fetch failed: ${json?.message || `HTTP ${status}`}`);
  }
  return json.data
    .map((p) => String(p?.pn ?? '').replace(/[^\d]/g, ''))
    .filter(Boolean);
}

/**
 * Lists every WhatsApp group with participants. Kept for the facade contract
 * (UltraMsg parity) and tools — the CR refresh path uses the budgeted,
 * cached orchestration instead. Participant fetches run SERIALLY with a
 * spacing (Wasender caps this endpoint at 10 req/min); the old parallel
 * burst silently emptied most rosters on 429s.
 */
export async function listGroups({ spacingMs = 700, cap = 25 } = {}) {
  const groups = await listGroupMeta();
  for (const g of groups.slice(0, cap)) {
    try {
      g.participants = await getGroupParticipants(g.id);
    } catch {
      g.participants = [];
    }
    await sleep(spacingMs);
  }
  return groups;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
