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
// Wasender-only (undefined on ultramsg): the bot's own WhatsApp profile.
export const getSelfProfile = () => impl().getSelfProfile?.();
export const getLidFromPhone = (phone) => impl().getLidFromPhone?.(phone) ?? null;

/* WASENDER ACCOUNT-PROTECTION PACING (2026-10-11): the paid Basic plan's
 * anti-ban guard rejects sends faster than 1 per 5 seconds ACCOUNT-WIDE
 * ("You have account protection enabled. You can only send 1 message
 *  every 5 seconds."). The facade serializes Wasender sends with a safe
 * gap so batch paths (sweep retries, broadcasts, teacher ack + CR ping)
 * never trip it. UltraMsg paces itself (sendDelayMax) — untouched. */
let lastSendAt = 0;
/* OWNER LIVE FIX (2026-10-11 night, "CR ko notify karne mein issue aa raha
 * hai"): Vercel serverless starts a FRESH module per invocation, so the
 * in-memory lastSendAt resets to 0 — a CR ping in a new invocation fired
 * <5s after a broadcast finished and Wasender's ACCOUNT PROTECTION rejected
 * it ("1 message every 5 seconds"). Durable floor: the newest successfully
 * sent OutboxMessage.sentAt also counts, so spacing survives cold starts. */
let durableFloorCache = { at: 0, val: 0 };
async function durableFloor() {
  try {
    if (Date.now() - durableFloorCache.at < 3000) return durableFloorCache.val;
    const { OutboxMessage } = await import('../models/index.js');
    const last = await OutboxMessage.findOne({ status: 'sent' }).sort({ sentAt: -1 }).select('sentAt').lean();
    const val = last?.sentAt ? new Date(last.sentAt).getTime() : 0;
    durableFloorCache = { at: Date.now(), val };
    return val;
  } catch { return 0; }
}
/* OWNER SPEC 2026-10-14 (fast delivery): the old single-Promise chain
 * serialized EVERY send behind ALL pending ones — a chatbot reply queued
 * behind a 10-file broadcast (10 x 5.2s) plus CR pings is exactly the
 * "file aane me 1-4 minute lagte hain" complaint. Now a real QUEUE with
 * priority: interactive sends (chatbot replies + files, front:true) jump
 * ahead of backlog items; the 5.2s provider spacing floor applies to
 * every send identically, so Account Protection still holds — only the
 * ORDER changes, never the rate. */
let sendQueue = [];
let pumping = false;
async function pumpQueue() {
  if (pumping) return;
  pumping = true;
  try {
    while (sendQueue.length) {
      const item = sendQueue.shift();
      const floor = Math.max(lastSendAt, await durableFloor());
      const wait = floor + env.whatsapp.sendSpacingMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { item.resolve(await item.fn()); } catch (err) { item.reject(err); }
      finally { lastSendAt = Date.now(); }
    }
  } finally { pumping = false; }
}
function paced(fn, { front = false } = {}) {
  if (impl() !== wasender || !env.whatsapp.sendSpacingMs) return fn();
  return new Promise((resolve, reject) => {
    if (front) sendQueue.unshift({ fn, resolve, reject });
    else sendQueue.push({ fn, resolve, reject });
    pumpQueue();
  });
}

/* Interactive (student-facing chatbot) sends get QUEUE PRIORITY — never
 * head-of-line-blocked behind broadcast/backlog bursts. Rate limit
 * unchanged. */
export const sendInteractiveText = (to, body, mentioned) => paced(() => impl().sendText(to, body, mentioned), { front: true });
export const sendInteractiveMedia = (kind, to, url, filename, caption) => paced(() => {
  if (kind === 'image') return impl().sendImage(to, url, caption);
  if (kind === 'audio') return impl().sendAudio(to, url);
  if (kind === 'video') return impl().sendVideo(to, url, caption);
  return impl().sendDocument(to, url, filename, caption);
}, { front: true });

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
/* ==========================================================================
 * OWNER SPEC 2026-10-11 (professional short CR notifications + clean
 * WhatsApp formatting): every bot-to-CR message passes through these two
 * helpers. Nothing raw, concatenated, or machine-shaped ever reaches a CR.
 * ========================================================================== */

/** Normalize text for WhatsApp: keep meaningful line breaks, kill noise.
 * - CRLF -> LF; literal escaped '\\n' text -> a real newline
 * - collapse repeated spaces/tabs INSIDE a line (never joins words)
 * - max ONE blank line between lines; strip markdown/HTML artifacts
 * - drop "Label: undefined/null" fragments and empty label lines
 * - strip a trailing "— Tri3M Class Agent"-style bot footer (owner wants
 *   short action-oriented CR text; identity lives in the sender number) */
export function sanitizeWhatsAppText(text) {
  let out = String(text ?? '');
  out = out.replace(/\r\n?/g, '\n');
  out = out.replace(/\\+n/g, '\n');              // literal "\n" artifacts
  out = out.replace(/<br\s*\/?>/gi, '\n');        // stray HTML breaks
  out = out.replace(/<[^>]{1,80}>/g, '');           // malformed HTML tags
  out = out.replace(/```+/g, '');                   // markdown fences
  out = out.replace(/\{(?:\s*"[^"{}]{0,60}"\s*:\s*[^{}]{0,80}\s*,?\s*){1,4}\}/g, ''); // JSON-shaped blobs
  out = out.replace(/[\u200B-\u200D\uFEFF]/g, ''); // zero-width chars
  out = out.split('\n').map((line) => line
    .replace(/[ \t]{2,}/g, ' ')          // collapse accidental double spaces
    .replace(/\s*:\s*(undefined|null|NaN|\[object Object\])\s*/gi, ' ') // dead labels
    .replace(/^(subject|section|teacher|filename|file|reference)\s*:\s*$/i, '') // empty labels
    .trim()).join('\n');
  out = out.replace(/\n{3,}/g, '\n\n');            // max one blank line
  out = out.replace(/^\s+|\s+$/g, '');
  // footer spam (agent sign-off lines) — CR messages end with the action
  out = out.replace(/\n*\s*[—-]\s*Tri3M(\s+Class(\s+Agent)?)?\s*$/i, '').trim();
  return out;
}

/** One-line field sanitizer for dynamic values (names, questions, subjects):
 * no newlines, no machine text, single spaces, capped length. */
export function cleanWhatsAppField(text, max = 120) {
  const out = String(text ?? '')
    .replace(/\{(?:\s*"[^"{}]{0,60}"\s*:\s*[^{}]{0,80}\s*,?\s*){1,4}\}/g, '') // JSON-shaped blobs
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[""\u201C\u201D]/g, '"')
    .replace(/[''\u2018\u2019]/g, "'")
    .replace(/\{\{.*?\}\}|\b(undefined|null|NaN)\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/["*]{3,}/g, '')
    .trim();
  return out.slice(0, max);
}

/** CR-bound tracked send: sanitized + outbox-deduped + provider id stored.
 * A repeated handler/sweep call can never double-send the same event. */
export async function sendCrTracked(phone, body, { kind = 'cr_notify', refKey = '', dedupeKey = '', once = true } = {}) {
  const clean = sanitizeWhatsAppText(body);
  if (!clean) return { sent: false, error: 'empty message' };
  return sendTracked(phone, clean, { kind, refKey, dedupeKey: dedupeKey || refKey, once });
}

export async function sendTracked(phone, body, { kind = 'teacher', refKey = '', dedupeKey = '', once = false, windowMs = 0 } = {}) {
  const digits = destPhone(phone);
  let row = null;
  try {
    const { OutboxMessage } = await import('../models/index.js');
    if (once && dedupeKey) {
      const since = new Date(Date.now() - (windowMs || 30 * 24 * 3600 * 1000));
      const existing = await OutboxMessage.findOne({ dedupeKey, status: 'sent', sentAt: { $gte: since } }).lean();
      if (existing) return { sent: true, alreadySent: true };
      /* ONE ROW PER KEY (owner spec 2026-10-12): a queued/failed row from an
       * earlier attempt is RE-DISPATCHED, never duplicated — the material
       * sweep retry and the outbox sweep can both retry the same broadcast
       * without any chance of delivering the file twice. */
      const prior = await OutboxMessage.findOne({ dedupeKey, status: { $in: ['queued', 'failed'] } })
        .sort({ createdAt: -1 });
      if (prior) {
        let ok2 = false; let err2 = '';
        try { ok2 = await dispatchRow(prior); } catch (err) { err2 = String(err?.message ?? err).slice(0, 300); }
        try { await OutboxMessage.updateOne({ _id: prior._id }, { $set: {
          status: ok2 ? 'sent' : 'failed', sentAt: ok2 ? new Date() : null,
          lastTriedAt: new Date(),
          attempts: (prior.attempts ?? 0) + (ok2 || !isRateLimitError(err2) ? 1 : 0),
          lastError: err2 } }); } catch { /* best-effort */ }
        return { sent: ok2, error: err2, redelivered: true };
      }
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
    // OWNER SPEC 2026-10-11 §1: persist the PROVIDER's message id/jid so
    // every outbound action is traceable to the gateway's own record.
    if (ok && row) {
      try { const { OutboxMessage } = await import('../models/index.js');
        await OutboxMessage.updateOne({ _id: row._id }, { $set: {
        providerMsgId: String(res?.msgId ?? '').slice(0, 220),
        providerJid: String(res?.jid ?? '').slice(0, 220) } }); } catch { /* best-effort */ }
    }
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
    // OWNER LIVE FIX (2026-10-11 night): media sends used the RAW gateway,
    // bypassing the paced chain — a broadcast upload + a CR text send raced
    // and Wasender's account protection rejected the second one. All sends
    // now share ONE paced chain, so a media upload and the CR ping after it
    // are always >= spacing apart.
    if (r.mediaKind === 'image') return Boolean((await sendImage(r.phone, r.url, r.body || undefined))?.sent);
    if (r.mediaKind === 'audio') return Boolean((await sendAudio(r.phone, r.url))?.sent);
    if (r.mediaKind === 'video') return Boolean((await sendVideo(r.phone, r.url, r.body || undefined))?.sent);
    return Boolean((await sendDocument(r.phone, r.url, r.filename, r.body || undefined))?.sent);
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