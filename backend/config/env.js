import 'dotenv/config';

const REQUIRED = ['MONGODB_URI', 'JWT_SECRET'];

export const env = {
  // WasenderApi session-scoped API key (send/media/groups — account-level
  // endpoints would need a Personal Access Token, which we do not use).
  wasender: {
    apiKey: process.env.WASENDER_API_KEY,
    apiUrl: process.env.WASENDER_API_URL || 'https://wasenderapi.com/api',
  },
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  attendanceSecret: process.env.ATTENDANCE_SECRET,
  brevoApiKey: process.env.BREVO_API_KEY,
  brevoSenderEmail: process.env.BREVO_SENDER_EMAIL,
  brevoSenderName: process.env.BREVO_SENDER_NAME,
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  brevoApiKey: process.env.BREVO_API_KEY,
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
  corsOrigin: process.env.CORS_ORIGIN,
  whatsapp: {
    // UltraMsg gateway — all optional; the teacher-alert feature degrades
    // gracefully (sweep reports configured:false) when not set.
    instanceId: process.env.ULTRAMSG_INSTANCE_ID,
    token: process.env.ULTRAMSG_TOKEN,
    apiUrl: process.env.ULTRAMSG_API_URL || 'https://api.ultramsg.com',
    sweepSecret: process.env.DEADLINE_SWEEP_SECRET,
    webhookSecret: process.env.ULTRAMSG_WEBHOOK_SECRET,
    // trial watchdog (cron-job.org pings /api/whatsapp/watchdog hourly)
    dashboardEmail: process.env.ULTRAMSG_DASHBOARD_EMAIL,
    dashboardPassword: process.env.ULTRAMSG_DASHBOARD_PASSWORD,
    instanceNumber: process.env.ULTRAMSG_INSTANCE_NUMBER,
    gatewayPhone: process.env.ULTRAMSG_GATEWAY_PHONE,
    // OWNER 2026-10-10: gateway selector — 'ultramsg' (default, unchanged
    // behavior) or 'wasender'. One variable = one rollback.
    gateway: process.env.WHATSAPP_GATEWAY || 'ultramsg',
    // WASENDER ACCOUNT PROTECTION (2026-10-11): the paid plan's anti-ban
    // guard rejects sends faster than 1 per 5 seconds account-wide
    // ("You have account protection enabled. You can only send 1 message
    //  every 5 seconds."). The facade paces Wasender sends with this gap.
    sendSpacingMs: Number(process.env.WASENDER_SEND_SPACING_MS ?? 5200),
    alertEmails: (process.env.WHATSAPP_WATCHDOG_ALERT_EMAILS || '')
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean),
  },
  // WhatsApp group chatbot (Tri3M answering students' questions inside their
  // linked class groups). Master switch + Gemini key are BOTH required — the
  // bot is dead silent unless WHATSAPP_CHATBOT_ENABLED is exactly 'true'.
  chatbot: {
    enabled: (process.env.WHATSAPP_CHATBOT_ENABLED || '').trim().toLowerCase() === 'true',
    googleApiKey: process.env.GOOGLE_API_KEY,
    model: process.env.CHATBOT_GEMINI_MODEL || 'gemini-3.8-flash', // 2.5-flash was retired by Google (404 for new users)
    // OpenAI Whisper — voice notes in the class group. Without the key
    // voice notes are consumed silently (feature simply never fires).
    openaiApiKey: process.env.OPENAI_API_KEY,
  },
};

/**
 * Fail fast on missing configuration.
 * Reports variable NAMES only — values (secrets) are never included in errors.
 */
export function ensureEnv(extra = []) {
  const missing = [...REQUIRED, ...extra].filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
