/**
 * WASENDER WEBHOOK OBSERVABILITY (2026-10-11, owner reliability spec item 9):
 * every accepted inbound webhook event is recorded here so ops-diagnostics
 * can prove webhook health (last inbound event, redelivery storms, group vs
 * direct volume). No message bodies are stored — ids and senders only.
 */
import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  msgId: { type: String, required: true, index: true },
  from: { type: String, default: '' }, // jid (group) or phone@c.us
  author: { type: String, default: '' }, // group sender, when present
  chatType: { type: String, default: 'direct' }, // 'group' | 'direct'
  msgType: { type: String, default: 'chat' },
  redelivery: { type: Boolean, default: false }, // provider re-sent an id we had seen
  at: { type: Date, default: Date.now },
  // INVESTIGATION 2026-10-11: raw payload STRUCTURE (keys only, values
  // redacted) — proves what the provider actually sends vs what we expect.
  rawShape: { type: String, default: '' },
  // OWNER AUDIT 2026-10-11 (flaky file flow): the rawShape schema recorder
  // hid what the teacher ACTUALLY typed, making wrong-approval/decline
  // verdicts undiagnosable. Store the real text (truncated, media names too).
  bodyText: { type: String, default: '', maxlength: 300 },
  // OWNER SPEC §E (2026-10-11): durable event-id idempotency for the GROUP
  // bot — the first invocation to mark an event botHandled owns the reply;
  // Wasender redeliveries of the same id are skipped silently.
  botHandled: { type: Boolean, default: false },
  // GROUP SILENCE TRACE (2026-10-11): WHY handleGroupMessage consumed a
  // message without replying — 'untagged' (tag mismatch), 'stale', 'budget',
  // 'no-section', etc. Redacted: reason + body length + mention tails only.
  groupTrace: { type: Object, default: null },
}, { timestamps: true });

export default mongoose.models.WhatsAppEvent || mongoose.model('WhatsAppEvent', schema);
