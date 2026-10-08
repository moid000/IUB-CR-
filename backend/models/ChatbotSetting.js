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
 * The Gemini API key is NOT stored here - it lives only in the server
 * environment (GOOGLE_API_KEY), set by the developer. The panel exposes a
 * single control: the ON/OFF switch.
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
  },
  { timestamps: true },
);

chatbotSettingSchema.index({ key: 1 }, { unique: true });

export default mongoose.model('ChatbotSetting', chatbotSettingSchema);
