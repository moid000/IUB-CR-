/**
 * LOCAL E2E SERVER — for browser QA only (never touches production Atlas).
 * In-memory MongoDB replica set (transactions required) + real backend app
 * + admin bootstrap. Run: node scripts/local-e2e-server.mjs
 *
 * SEED_CR=1 additionally seeds a complete CR workspace (department, session,
 * section, active CR with a known test password, an active student, two
 * subjects) for the CR-portal UI E2E. Step 14's admin E2E runs WITHOUT this
 * flag so its empty-state assertions stay valid.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'local-e2e-jwt-secret';
process.env.ADMIN_EMAIL = 'admin@local.test';
process.env.ADMIN_PASSWORD = 'Step14Admin!2026';
process.env.BREVO_API_KEY = 'mock';
process.env.BREVO_SENDER_EMAIL = 'e2e@local.test'; // mocked below — no real email is ever sent
process.env.BREVO_SENDER_NAME = 'IUB E2E';
process.env.ATTENDANCE_SECRET = 'local-e2e-attendance-secret';
// Fake Cloudinary — signs are generated locally; UI E2E intercepts the
// browser-direct upload so NO real API call is ever made.
process.env.CLOUDINARY_CLOUD_NAME = 'e2e-cloud';
process.env.CLOUDINARY_API_KEY = 'e2e-key-123456';
process.env.CLOUDINARY_API_SECRET = 'e2e-secret-abcdef'; // QR signing (503 if unset) // emails never sent locally (OTP flows not exercised here)

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('local_e2e');

const { default: mongoose } = await import('mongoose');
const models = await import('../backend/models/index.js');
const { default: app } = await import('../backend/app.js');
const { ensureAdminBootstrap, runAdminBootstrap } = await import('../backend/services/adminBootstrap.js');

/* --------- test-only OTP capture (intercepts the mocked Brevo call) --------- */
const sentOtps = new Map(); // email(lower) -> 6-digit plaintext (NEVER exposed to clients below except the guarded test route)
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  if (String(url).includes('api.brevo.com')) {
    try {
      const b = JSON.parse(init?.body ?? '{}');
      const to = String(b?.to?.[0]?.email ?? '').toLowerCase();
      const m = String(b?.textContent ?? '').match(/code is:?\s*(\d{6})/i);
      if (to && m) sentOtps.set(to, m[1]);
    } catch { /* malformed — ignore */ }
    return Promise.resolve(new Response('{"message":"queued"}', {
      status: 201, headers: { 'content-type': 'application/json' },
    }));
  }
  return realFetch(url, init);
};

await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
await ensureAdminBootstrap();
if (process.env.SEED_CR === '1') await seedCrWorkspace();

/* ------------------------- CR portal seed (test-only) ------------------------- */
async function seedCrWorkspace() {
  const bcrypt = (await import('bcryptjs')).default; // same hasher the backend uses
  const { Department, AcademicSession, Section, Subject, User } = models;

  const dept = await Department.create({ name: 'Computer Science', code: 'CS' });
  const session = await AcademicSession.create({ name: 'Fall 2026', status: 'active' });
  const section = await Section.create({ department: dept._id, session: session._id, semester: 3, name: 'A' });

  const cr = new User({
    name: 'Test CR',
    email: 'cr@local.test',
    role: 'cr',
    section: section._id,
    registrationStatus: 'active',
    emailVerified: true,
  });
  cr.password = await bcrypt.hash('CrPortal!2026', 12);
  await cr.save();
  section.cr = cr._id;
  await section.save();

  await User.create([{
    name: 'Ali Khan', email: 'ali@local.test', role: 'student', section: section._id,
    rollNo: 'ST-001', registrationStatus: 'active', emailVerified: true,
    password: await bcrypt.hash('Student!2026', 12),
  }]);

  await Subject.create([
    { section: section._id, createdBy: cr._id, name: 'Programming Fundamentals', code: 'CS-101', teacherName: 'Dr. Ahmed', creditHours: 3 },
    { section: section._id, createdBy: cr._id, name: 'Data Structures', code: 'CS-201', teacherName: 'Dr. Sana', creditHours: 4 },
  ]);

  console.log('CR SEED READY: cr@local.test / CrPortal!2026 (section A, sem 3, CS-101 + CS-201, student ST-001)');
}

/* ---- E2E reset hook (local-only; picked up by the test hook in app.js) ---- */
app.set('__e2eReset', async (req, res) => {
  try {
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
    await runAdminBootstrap(); // cached ensureAdminBootstrap would no-op after a wipe
    if (process.env.SEED_CR === '1') await seedCrWorkspace();
    res.json({ success: true, note: 'db wiped + re-seeded for a fresh idempotent E2E run' });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err?.message ?? err) });
  }
});

const server = app.listen(3000, () => {
  console.log(`LOCAL E2E READY: backend on :3000, admin = admin@local.test / Step14Admin!2026${process.env.SEED_CR === '1' ? ' (+ CR seed)' : ''}`);
});

/* test-only OTP introspection — wrapped at the HTTP layer so it can NOT be
   shadowed by app.js's 404 catch-all; hard-gated to NODE_ENV=test. */
{
  const orig = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const url = (req.url || '').split('?')[0];
    if (process.env.NODE_ENV === 'test' && url.startsWith('/__e2e/otp/')) {
      const email = decodeURIComponent(url.slice('/__e2e/otp/'.length)).toLowerCase();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, otp: sentOtps.get(email) ?? null }));
      return;
    }
    orig.forEach((l) => l(req, res));
  });
}

const shutdown = async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
