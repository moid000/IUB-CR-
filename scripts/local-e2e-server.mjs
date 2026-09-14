/**
 * LOCAL E2E SERVER — for browser QA only (never touches production Atlas).
 * In-memory MongoDB replica set (transactions required) + real backend app
 * + admin bootstrap. Run: node scripts/local-e2e-server.mjs
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'local-e2e-jwt-secret';
process.env.ADMIN_EMAIL = 'admin@local.test';
process.env.ADMIN_PASSWORD = 'Step14Admin!2026';
process.env.BREVO_API_KEY = 'mock'; // emails never sent locally (OTP flows not exercised here)

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('local_e2e');

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { ensureAdminBootstrap } = await import('../backend/services/adminBootstrap.js');

await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
await ensureAdminBootstrap();

const server = app.listen(3000, () => {
  console.log('LOCAL E2E READY: backend on :3000, admin = admin@local.test / Step14Admin!2026');
});

const shutdown = async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
