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
}, { timestamps: true });

export default mongoose.models.WhatsAppEvent || mongoose.model('WhatsAppEvent', schema);
