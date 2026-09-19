import 'dotenv/config';

const REQUIRED = ['MONGODB_URI', 'JWT_SECRET'];

export const env = {
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
    // trial watchdog (cron-job.org pings /api/whatsapp/watchdog hourly)
    dashboardEmail: process.env.ULTRAMSG_DASHBOARD_EMAIL,
    dashboardPassword: process.env.ULTRAMSG_DASHBOARD_PASSWORD,
    instanceNumber: process.env.ULTRAMSG_INSTANCE_NUMBER,
    alertEmails: (process.env.WHATSAPP_WATCHDOG_ALERT_EMAILS || '')
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean),
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
