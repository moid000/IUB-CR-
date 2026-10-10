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

export const isConfigured = () => impl().isConfigured();
export const sendText = (to, body, mentioned) => impl().sendText(to, body, mentioned);
export const sendImage = (to, url, caption) => impl().sendImage(to, url, caption);
export const sendDocument = (to, url, filename, caption) => impl().sendDocument(to, url, filename, caption);
export const sendAudio = (to, url) => impl().sendAudio(to, url);
export const sendVideo = (to, url, caption) => impl().sendVideo(to, url, caption);
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

/* OWNER RELIABILITY SPEC §9 (2026-10-10): tracked teacher-flow send.
 * Persists the outbound message BEFORE the gateway call; 'sent' only on
 * real gateway confirmation. A failure leaves a retryable row for the
 * sweep (bounded) — the reply is never silently lost. NEVER throws: the
 * boolean result lets callers treat a failed send as "delivery pending".
 * `once` (dedupeKey + windowMs) makes a send exactly-once per window. */
export async function sendTracked(phone, body, { kind = 'teacher', refKey = '', dedupeKey = '', once = false, windowMs = 0 } = {}) {
  const digits = String(phone ?? '').replace(/\D/g, '');
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
        lastTriedAt: new Date(), attempts: 1, lastError: error } });
    } catch { /* best-effort */ }
  }
  return { sent: ok, error };
}

/* Sweep step (bounded retry): failed outbox rows re-sent, max 6 attempts. */
export async function retryOutbox(limit = 20) {
  const out = { retried: 0, delivered: 0, dead: 0 };
  try {
    const { OutboxMessage } = await import('../models/index.js');
    const due = await OutboxMessage.find({ status: 'failed', attempts: { $lt: 6 },
      $or: [{ lastTriedAt: null }, { lastTriedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }] })
      .sort({ updatedAt: 1 }).limit(limit).lean();
    for (const r of due) {
      let ok = false; let error = '';
      try {
        const res = await sendText(r.phone, r.body);
        ok = Boolean(res?.sent);
        if (!ok) error = 'gateway did not confirm send';
      } catch (err) { error = String(err?.message ?? err).slice(0, 300); }
      await OutboxMessage.updateOne({ _id: r._id }, { $set: {
        status: ok ? 'sent' : 'failed', sentAt: ok ? new Date() : null,
        lastTriedAt: new Date() }, $inc: { attempts: 1 }, lastError: error });
      out.retried += 1; if (ok) out.delivered += 1;
    }
  } catch (err) { console.error('[outbox retry]', err.message); }
  return out;
}