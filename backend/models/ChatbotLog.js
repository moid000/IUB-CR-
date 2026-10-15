import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Chatbot QA log — every question the Tri3M WhatsApp bot answers in a
 * class group, and every file it delivers. READ-ONLY audit trail for the
 * owner: nothing in the bot ever WRITES to existing records; this new
 * collection is the only thing it creates. Records are kept short
 * (question/reply capped) and old ones can be trimmed freely.
 */
const chatbotLogSchema = new Schema(
  {
    section: { type: Schema.Types.ObjectId, ref: 'Section' },
    groupId: { type: String, trim: true, maxlength: 120 },
    // OWNER SPEC 2026-10-13 §1 (persistent conversation memory): WHO said it
    // and WHICH stable inbound message it answers — history lines are
    // rendered per-student and duplicates stay idempotent end-to-end.
    asker: { type: String, trim: true, maxlength: 24 },
    msgId: { type: String, trim: true, maxlength: 100 },
    question: { type: String, trim: true, maxlength: 500 },
    reply: { type: String, trim: true, maxlength: 1200 },
    sentFiles: { type: Number, default: 0 },
    // titles this reply listed/offered (notes + assignments) — lets the
    // NEXT message resolve a pick like "ye wala / dusra wala" (owner feature)
    offeredTitles: { type: [String], default: [] },
    // where the answer came from: 'gemini' (LLM), 'groq' (free-tier fallback
    // LLM) or 'fallback' (keyword router). OWNER FIX 2026-10-15: 'groq' was
    // missing from the enum, so every Groq-sourced answer SENT fine but the
    // audit log write threw (log-failed) — ops evidence went stale.
    source: { type: String, enum: ['gemini', 'groq', 'fallback', 'error'], default: 'gemini' },
    error: { type: String, trim: true, maxlength: 300 },
    latencyMs: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

chatbotLogSchema.index({ createdAt: -1 });
chatbotLogSchema.index({ section: 1, createdAt: -1 });
chatbotLogSchema.index({ groupId: 1, createdAt: -1 }); // history retrieval path


const ChatbotLog = mongoose.model('ChatbotLog', chatbotLogSchema);

export default ChatbotLog;
