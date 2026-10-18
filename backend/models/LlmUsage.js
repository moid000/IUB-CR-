import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * OWNER FEATURE 2026-10-18 — PER-MODEL LLM USAGE TELEMETRY.
 * One document per (day, provider, model) — a live counter of the chat
 * pipeline's LLM calls: total, ok, 429-quota failures, other failures, and
 * the LAST failure reason with its timestamp. Powers the Administration
 * panel's model-health card ("total vs remaining" + "why is this model not
 * working"). Written fire-and-forget via atomic upserts — telemetry can
 * never slow or break a chat reply. PKT day key (Asia/Karachi, UTC+5).
 */
const llmUsageSchema = new Schema(
  {
    day: { type: String, required: true, index: true }, // 'YYYY-MM-DD' (PKT)
    provider: { type: String, required: true, enum: ['gemini', 'groq'], index: true },
    model: { type: String, required: true, maxlength: 80 },
    calls: { type: Number, default: 0 },
    ok: { type: Number, default: 0 },
    fail429: { type: Number, default: 0 },
    failOther: { type: Number, default: 0 },
    lastError: { type: String, default: '', maxlength: 300 }, // human reason: '429 quota' / 'timeout' / provider text
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true }
);

llmUsageSchema.index({ day: 1, provider: 1, model: 1 }, { unique: true });

export default mongoose.models.LlmUsage || mongoose.model('LlmUsage', llmUsageSchema);
