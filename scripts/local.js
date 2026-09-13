// Local development server ONLY — production runs on Vercel Serverless (api/index.js).
import app from '../backend/app.js';
import { connectDB } from '../backend/config/db.js';
import { env } from '../backend/config/env.js';

const PORT = process.env.PORT || 8080;

await connectDB();
app.listen(PORT, () => {
  console.log(`[${env.nodeEnv}] IUB Class Management API → http://localhost:${PORT}/api/health`);
});
