import 'dotenv/config';

const REQUIRED = ['MONGODB_URI', 'JWT_SECRET'];

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  attendanceSecret: process.env.ATTENDANCE_SECRET,
  adminEmail: process.env.ADMIN_EMAIL,
  brevoApiKey: process.env.BREVO_API_KEY,
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
  corsOrigin: process.env.CORS_ORIGIN,
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
