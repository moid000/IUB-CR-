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
 * apiKey is the Google AI Studio (Gemini) key pasted from the admin panel.
 * It overrides the GOOGLE_API_KEY env var when present. It is NEVER returned
 * by any API route — reads only expose whether a key is configured.
 */
const chatbotSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    enabled: { type: Boolean, default: false },
    apiKey: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

chatbotSettingSchema.index({ key: 1 }, { unique: true });

export default mongoose.model('ChatbotSetting', chatbotSettingSchema);
