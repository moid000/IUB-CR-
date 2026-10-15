import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Tri3M WhatsApp group chatbot settings — singleton record (key: 'global').
 *
 * The owner flips the bot ON/OFF from the admin panel's Administration
 * section at any time. Until this document is created the bot falls back to
 * the WHATSAPP_CHATBOT_ENABLED env var (default OFF), so a fresh deploy is
 * always silent until the owner explicitly turns it on.
 *
 * OWNER QUOTA-POOL FIX 2026-10-14: the panel can now store a POOL of extra
 * free Gemini AI Studio keys (geminiKeys) — the owner pastes them comma-
 * separated in the Administration card. Every Gemini chain rotates to the
 * next key when one hits 429 quota. Values are NEVER returned by any API
 * (only geminiKeysCount + masked tails). The server env GOOGLE_API_KEY
 * stays in the pool as the final fallback.
 *
 */
const chatbotSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    enabled: { type: Boolean, default: false },
    // OWNER 2026-10-08 — OpenAI key for VOICE-NOTE transcription (Whisper).
    // Panel value wins over the OPENAI_API_KEY env var. Stored here, NEVER
    // returned by any API (only openaiKeyConfigured/openaiKeySource flags).
    openaiApiKey: { type: String, default: '' },
    // OWNER QUOTA-POOL FIX 2026-10-14: panel-pasted free AI Studio keys.
    // Run BEFORE env keys (fresh quota first); every chain rotates on 429.
    geminiKeys: { type: [String], default: [] },
    // OWNER FEATURE 2026-10-15 (24/7 uptime): OPTIONAL Groq free-tier key —
    // when the whole Gemini chain dies (quota/throttling) the same prompts
    // run on Groq so the bot never pauses while free capacity exists.
    // Stored here, NEVER returned by any API (present flag + masked tail).
    groqApiKey: { type: String, default: '' },
    // OWNER SPEC 2026-10-14 (AI-pause fix): durable circuit breaker — when
    // EVERY model in the Gemini chain fails (quota/503 outage), the chain
    // is skipped until this instant. Never blocks the deterministic data
    // paths (timetable/deadlines/notes) which keep answering from the DB.
    aiOutageUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

chatbotSettingSchema.index({ key: 1 }, { unique: true });

export default mongoose.model('ChatbotSetting', chatbotSettingSchema);
