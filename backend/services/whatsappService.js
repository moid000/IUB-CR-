import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';

/**
 * WhatsApp delivery service — UltraMsg gateway.
 *
 * DESIGN NOTE (swap-friendly): every caller uses ONLY sendText(). The vendor
 * specifics (URL shape, form encoding, response codes) live in THIS file alone,
 * so switching to WasenderAPI or Meta's official Cloud API later means editing
 * only this module — no route/controller changes anywhere else.
 *
 * Numbers are international digits WITHOUT '+' (e.g. 923001234567) — exactly
 * the format UltraMsg expects, and the format teacherService normalizes to.
 */

const SEND_TIMEOUT_MS = 20_000;

export function isConfigured() {
  return Boolean(env.whatsapp.instanceId && env.whatsapp.token);
}

function endpoint(path) {
  const base = (env.whatsapp.apiUrl || 'https://api.ultramsg.com').replace(/\/+$/, '');
  return `${base}/${env.whatsapp.instanceId}${path}`;
}

/**
 * Low-level POST via global fetch (kept in one place so tests can stub
 * globalThis.fetch to simulate the gateway without any network).
 */
export async function postForm(url, params) {
  const body = new URLSearchParams(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
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

/**
 * Sends a plain-text WhatsApp message (WhatsApp *bold* markers supported).
 * Throws ApiError on any gateway failure — callers decide retry semantics.
 */
export async function sendText(to, body) {
  if (!isConfigured()) {
    throw new ApiError(503, 'WhatsApp gateway is not configured');
  }
  const { ok, status, json } = await postForm(endpoint('/messages/chat'), {
    token: env.whatsapp.token,
    to,
    body,
  });

  if (!ok || json?.error) {
    const detail = json?.error || `HTTP ${status}`;
    throw new ApiError(502, `WhatsApp send failed: ${detail}`);
  }
  return json;
}

/**
 * Lists every WhatsApp group the paired number currently belongs to.
 * Returns a normalized [{ id, name, participants }] — participants are
 * member numbers as bare international digits (e.g. 923019670950),
 * extracted from the vendor's groupMetadata. The caller (CR group picker)
 * never sees raw vendor payloads. Empty array simply means the number has
 * not been added to any group yet.
 */
export async function listGroups() {
  if (!isConfigured()) {
    throw new ApiError(503, 'WhatsApp gateway is not configured');
  }
  const url = `${endpoint('/groups')}?token=${encodeURIComponent(env.whatsapp.token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON gateway response */ }
  if (!res.ok || json?.error) {
    throw new ApiError(502, `WhatsApp groups fetch failed: ${json?.error || `HTTP ${res.status}`}`);
  }
  if (!Array.isArray(json)) {
    throw new ApiError(502, 'Unexpected WhatsApp groups response');
  }
  return json
    .map((g) => {
      if (typeof g === 'string') return { id: g, name: g, participants: [] };
      const id = String(g?.id ?? '');
      const participants = Array.isArray(g?.groupMetadata?.participants)
        ? g.groupMetadata.participants
            .map((p) => String(p?.id ?? '').split('@')[0].replace(/[^\d]/g, ''))
            .filter(Boolean)
        : [];
      return { id, name: String(g?.name ?? (id || 'Group')), participants };
    })
    .filter((g) => g.id); // skip malformed entries
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
