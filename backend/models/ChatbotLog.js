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
    question: { type: String, trim: true, maxlength: 500 },
    reply: { type: String, trim: true, maxlength: 1200 },
    sentFiles: { type: Number, default: 0 },
    // titles this reply listed/offered (notes + assignments) — lets the
    // NEXT message resolve a pick like "ye wala / dusra wala" (owner feature)
    offeredTitles: { type: [String], default: [] },
    // where the answer came from: 'gemini' (LLM) or 'fallback' (keyword router)
    source: { type: String, enum: ['gemini', 'fallback', 'error'], default: 'gemini' },
    error: { type: String, trim: true, maxlength: 300 },
    latencyMs: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

chatbotLogSchema.index({ createdAt: -1 });
chatbotLogSchema.index({ section: 1, createdAt: -1 });


const ChatbotLog = mongoose.model('ChatbotLog', chatbotLogSchema);

export default ChatbotLog;
