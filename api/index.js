// Vercel Serverless entry — single Express app handles all /api/* routes.
// vercel.json rewrites /api/:path* to this function; the original URL is
// preserved, so Express routing works normally.
import app from '../backend/app.js';

export default app;
