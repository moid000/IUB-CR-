/**
 * WhatsApp delivery FACADE (2026-10-10 gateway migration).
 *
 * Every caller imports from THIS module only. The active implementation is
 * chosen per call from env.whatsapp.gateway:
 *   - 'ultramsg' (default): ultramsgGateway.js — byte-for-byte the pre-migration
 *     behavior. NOTHING changes for the live system until the flag flips.
 *   - 'wasender': wasenderGateway.js — same signatures, same return shapes.
 *
 * sendTracked / retryOutbox (the outbox) are gateway-agnostic and live here,
 * so both gateways share one delivery-retry path.
 */
import { env } from '../config/env.js';
import * as ultramsg from './ultramsgGateway.js';
import * as wasender from './wasenderGateway.js';

const impl = () => (env.whatsapp.gateway === 'wasender' ? wasender : ultramsg);

/**
 * WASENDER TRIAL THROTTLE GUARD (2026-10-10): the trial plan allows only
 * 1 send/min (paid 256/min) and returns "You are on a free trial. You can
 * send 1 message every 1 minute." Being THROTTLED is not a delivery failure
 * — it must never burn a message's bounded retry attempts, or every queued
 * send dies at the cap while the owner is still on the trial plan.
 */
const RATE_LIMIT_RE = /free trial|rate.?limit|retry.?after|too many requests|account protection|\b429\b|1 message every/i;
export const isRateLimitError = (text) => RATE_LIMIT_RE.test(String(text ?? ''));

export const isConfigured = () => impl().isConfigured();

/* WASENDER ACCOUNT-PROTECTION PACING (2026-10-11): the paid Basic plan's
 * anti-ban guard rejects sends faster than 1 per 5 seconds ACCOUNT-WIDE
 * ("You have account protection enabled. You can only send 1 message
 *  every 5 seconds."). The facade serializes Wasender sends with a safe
 * gap so batch paths (sweep retries, broadcasts, teacher ack + CR ping)
 * never trip it. UltraMsg paces itself (sendDelayMax) — untouched. */
let lastSendAt = 0;
let sendChain = Promise.resolve();
function paced(fn) {
  if (impl() !== wasender || !env.whatsapp.sendSpacingMs) return fn();
  const run = sendChain.then(async () => {
    const wait = lastSendAt + env.whatsapp.sendSpacingMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { lastSendAt = Date.now(); }
  });
  sendChain = run.then(() => {}, () => {});
  return run;
}

export const sendText = (to, body, mentioned) => paced(() => impl().sendText(to, body, mentioned));
export const sendImage = (to, url, caption) => paced(() => impl().sendImage(to, url, caption));
export const sendDocument = (to, url, filename, caption) => paced(() => impl().sendDocument(to, url, filename, caption));
export const sendAudio = (to, url) => paced(() => impl().sendAudio(to, url));
export const sendVideo = (to, url, caption) => paced(() => impl().sendVideo(to, url, caption));
export const listGroups = () => impl().listGroups();

/**
 * Group meta WITHOUT triggering per-group roster fetches (Wasender rate
 * limit). UltraMsg fallback: its single /groups call already carries
 * participants, so the meta objects keep them — the caller detects that
 * single-call shape and skips per-group fetches entirely.
 */
export async function listGroupMeta() {
  const i = impl();
  if (typeof i.listGroupMeta === 'function') return i.listGroupMeta();
  return i.listGroups();
}

/** One group's roster (bare intl digits). UltraMsg fallback derives it
 *  from its single-call listGroups() result. Throws on failure. */
export async function getGroupParticipants(groupId) {
  const i = impl();
  if (typeof i.getGroupParticipants === 'function') return i.getGroupParticipants(groupId);
  const all = await i.listGroups();
  return (all.find((g) => g.id === groupId)?.participants) ?? [];
}
export const postForm = (url, params) => impl().postForm(url, params);
export const sleep = (ms) => impl().sleep(ms);

/** Outbox destination: plain phone digits for people, the FULL @g.us jid
 * preserved for groups (broadcasts) — digits-only would misroute groups. */
const destPhone = (phone) => {
  const raw = String(phone ?? '');
  return raw.includes('@g.us') ? raw : raw.replace(/\D/g, '');
};

/* OWNER RELIABILITY SPEC §9 (2026-10-10): tracked teacher-flow send.
 * Persists the outbound message BEFORE the gateway call; 'sent' only on
 * real gateway confirmation. A failure leaves a retryable row for the
 * sweep (bounded) — the reply is never silently lost. NEVER throws: the
 * boolean result lets callers treat a failed send as "delivery pending".
 * `once` (dedupeKey + windowMs) makes a send exactly-once per window. */
export async function sendTracked(phone, body, { kind = 'teacher', refKey = '', dedupeKey = '', once = false, windowMs = 0 } = {}) {
  const digits = destPhone(phone);
  let row = null;
  try {
    const { OutboxMessage } = await import('../models/index.js');
    if (once && dedupeKey) {
      const since = new Date(Date.now() - (windowMs || 30 * 24 * 3600 * 1000));
      const existing = await OutboxMessage.findOne({ dedupeKey, status: 'sent', sentAt: { $gte: since } }).lean();
      if (existing) return { sent: true, alreadySent: true };
    }
    row = await OutboxMessage.create({ phone: digits, kind, refKey, dedupeKey, body: String(body ?? '').slice(0, 4000), status: 'queued' });
  } catch (err) {
    console.error('[outbox] persist failed:', err.message);
  }
  let ok = false; let error = '';
  try {
    const res = await sendText(digits, String(body ?? ''));
    ok = Boolean(res?.sent);
    if (!ok) error = 'gateway did not confirm send';
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 300);
  }
  if (row) {
    try {
      const { OutboxMessage } = await import('../models/index.js');
      await OutboxMessage.updateOne({ _id: row._id }, { $set: {
        status: ok ? 'sent' : 'failed', sentAt: ok ? new Date() : null,
        lastTriedAt: new Date(),
        attempts: ok || !isRateLimitError(error) ? 1 : 0, // throttle burns no attempt
        lastError: error } });
    } catch { /* best-effort */ }
  }
  return { sent: ok, error };
}

/** Dispatch an outbox row's actual send — text or media (2026-10-11). */
async function dispatchRow(r) {
  if (r.url && r.mediaKind) {
    const i = impl();
    if (r.mediaKind === 'image') return Boolean((await i.sendImage(r.phone, r.url, r.body || undefined))?.sent);
    if (r.mediaKind === 'audio') return Boolean((await i.sendAudio(r.phone, r.url))?.sent);
    if (r.mediaKind === 'video') return Boolean((await i.sendVideo(r.phone, r.url, r.body || undefined))?.sent);
    return Boolean((await i.sendDocument(r.phone, r.url, r.filename, r.body || undefined))?.sent);
  }
  return Boolean((await sendText(r.phone, r.body))?.sent);
}

/** Tracked MEDIA send (2026-10-11): broadcast attachments persist an outbox
 * row BEFORE sending, so a throttled/partial burst is finished by the sweep
 * without duplicate uploads. Same honesty contract as sendTracked. */
export async function sendTrackedMedia(phone, mediaKind, { url, caption = '', filename = '' } = {},
    { kind = 'broadcast', refKey = '', dedupeKey = '', once = false, windowMs = 0 } = {}) {
  const digits = destPhone(phone);
  if (!digits) return { sent: false, error: 'no phone' };
  if (!url) return { sent: false, error: 'no url' };
  let row = null;
  try {
    const { OutboxMessage } = await import('../models/index.js');
    if (once && dedupeKey) {
      const since = new Date(Date.now() - (windowMs || 30 * 24 * 3600 * 1000));
      const existing = await OutboxMessage.findOne({ dedupeKey, status: 'sent', sentAt: { $gte: since } }).lean();
      if (existing) return { sent: true, alreadySent: true };
    }
    row = await OutboxMessage.create({ phone: digits, kind, refKey, dedupeKey,
      body: String(caption ?? '').slice(0, 4000), url: String(url).slice(0, 1024),
      mediaKind: String(mediaKind), filename: String(filename ?? '').slice(0, 255), status: 'queued' });
  } catch (err) {
    console.error('[outbox] persist failed:', err.message);
  }
  let ok = false; let error = '';
  try {
    ok = await dispatchRow(row ?? { phone: digits, body: caption, url, mediaKind, filename });
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 300);
  }
  if (row) {
    try {
      const { OutboxMessage } = await import('../models/index.js');
      await OutboxMessage.updateOne({ _id: row._id }, { $set: {
        status: ok ? 'sent' : 'failed', sentAt: ok ? new Date() : null,
        lastTriedAt: new Date(),
        attempts: ok || !isRateLimitError(error) ? 1 : 0, // throttle burns no attempt
        lastError: error } });
    } catch { /* best-effort */ }
  }
  return { sent: ok, error };
}

/* Sweep step (bounded retry with BACKOFF): failed outbox rows re-sent —
 * fast tier 6 attempts every 5 min, slow tier attempts 6-12 hourly
 * (2026-10-11, owner reliability spec item 8: bounded retries + backoff). */
export async function retryOutbox(limit = 10) { // paced: ~5.2s/send, fits the 60s sweep window
  const out = { retried: 0, delivered: 0, dead: 0 };
  try {
    const { OutboxMessage } = await import('../models/index.js');
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const due = await OutboxMessage.find({ status: 'failed',
      $or: [
        { attempts: { $lt: 6 }, $or: [{ lastTriedAt: null }, { lastTriedAt: { $lt: fiveMinAgo } }] },
        { attempts: { $gte: 6, $lt: 12 }, $or: [{ lastTriedAt: null }, { lastTriedAt: { $lt: oneHourAgo } }] },
      ] }).sort({ updatedAt: 1 }).limit(limit).lean();
    for (const r of due) {
      let ok = false; let error = '';
      try {
        ok = await dispatchRow(r);
        if (!ok) error = 'gateway did not confirm send';
      } catch (err) { error = String(err?.message ?? err).slice(0, 300); }
      if (!ok && isRateLimitError(error)) {
        // throttled by the provider plan — not a delivery failure. Record it,
        // burn no attempt, and STOP this pass: on a throttled plan every
        // further send in the same pass would 429 too. The next 5-min sweep
        // picks the row up again (row stays eligible: attempts unchanged).
        await OutboxMessage.updateOne({ _id: r._id }, { $set: {
          lastTriedAt: new Date(), lastError: error } });
        out.throttled = (out.throttled ?? 0) + 1;
        break;
      }
      await OutboxMessage.updateOne({ _id: r._id }, { $set: {
        status: ok ? 'sent' : 'failed', sentAt: ok ? new Date() : null,
        lastTriedAt: new Date() }, $inc: { attempts: 1 }, lastError: error });
      out.retried += 1; if (ok) out.delivered += 1;
    }
  } catch (err) { console.error('[outbox retry]', err.message); }
  return out;
}