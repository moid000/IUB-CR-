import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env, ensureEnv } from './config/env.js';
import { connectDB } from './config/db.js';
import routes from './routes/index.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import crRoutes from './routes/cr.js';
import studentRoutes from './routes/student.js';
import whatsappRoutes from './routes/whatsapp.js';
import { ensureAdminBootstrap } from './services/adminBootstrap.js';
import { ApiError, notFoundHandler, errorHandler } from './middleware/error.js';

ensureEnv(); // fail fast — reports variable names only, never values

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Vercel's proxy — req.ip resolves to the client IP

// Security headers
app.use(helmet());

// Strict CORS: the frontend and API are same-origin on Vercel, so no CORS
// headers are needed in production. CORS_ORIGIN (comma-separated) is only for
// local development with a separate frontend dev server.
if (env.corsOrigin) {
  app.use(
    cors({
      origin: env.corsOrigin.split(',').map((s) => s.trim()),
      credentials: true,
    })
  );
}

// JSON body limit for API requests (large file uploads go directly to
// Cloudinary in a later phase — never through Express)
app.use(express.json({ limit: '1mb' }));

app.use(cookieParser());

// Serverless-safe cached MongoDB connection (runs before every request)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch {
    next(new ApiError(503, 'Database unavailable'));
  }
});

// Idempotent admin bootstrap — runs once per serverless instance.
// Fail-safe: a configuration conflict is logged clearly but never breaks the API.
app.use(async (req, res, next) => {
  try {
    await ensureAdminBootstrap();
  } catch (err) {
    console.error('[bootstrap]', err.message);
  }
  next();
});

// Test-only hook: local E2E server attaches its DB reset handler via app.set().
// In production nothing registers the handler, so this passes through to 404.
app.use('/api/__e2e', (req, res, next) => {
  const handler = app.get('__e2eReset');
  if (req.method === 'POST' && req.path === '/reset' && typeof handler === 'function') return handler(req, res);
  return next();
});


// TEMP QA-ONLY: secret-gated impersonation for WhatsApp-group page QA.
// Remove this block (and TEMP_QA_LOGIN_SECRET env var) after QA is done.
app.get('/api/__qa/impersonate', async (req, res, next) => {
  try {
    if (!process.env.TEMP_QA_LOGIN_SECRET || req.query.secret !== process.env.TEMP_QA_LOGIN_SECRET) {
      return res.status(404).end();
    }
    const { default: User } = await import('./models/User.js');
    const { issueToken, setAuthCookie } = await import('./services/authService.js');
    const user = await User.findOne({ email: String(req.query.email || '').toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'no such user' });
    setAuthCookie(res, issueToken(user));
    res.json({ success: true, role: user.role, id: String(user._id), status: user.registrationStatus });
  } catch (err) { next(err); }
});

app.use('/api', routes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/cr', crRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/whatsapp', whatsappRoutes); // secret-protected pinger endpoints (no user auth)

// Consistent 404 for unknown API paths
app.use(notFoundHandler);

// Centralized error handling — never leaks internals
app.use(errorHandler);

export default app;
