// LIVE REPRO of the 22:51:55 silent PDF webhook (owner report 2026-10-08 23:30)
// Real S3 media URL + REAL Gemini classify; api.ultramsg.com mocked (no real sends).
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongod = await MongoMemoryReplSet.create({ replSetCount: 1 });
process.env.MONGODB_URI = mongod.getUri('repro_test');
process.env.JWT_SECRET = 'repro-jwt';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'owner@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass123!456';
process.env.ULTRAMSG_INSTANCE_ID = 'instance138500';
process.env.ULTRAMSG_TOKEN = 'fake-token';
process.env.ULTRAMSG_WEBHOOK_SECRET = 'fake-webhook-secret';
process.env.DEADLINE_SWEEP_SECRET = 'fake-sweep-secret';
process.env.GOOGLE_API_KEY = (await import('node:fs')).readFileSync('/app/.agents/.env', 'utf8').match(/GOOGLE_API_KEY=\$?'([^']+)'/)?.[1];
process.env.ALLOW_TEST_GEMINI = '1';
process.env.CLOUDINARY_CLOUD_NAME = 'demo';
process.env.CLOUDINARY_API_KEY = 'key';
process.env.CLOUDINARY_API_SECRET = 'secret';

const S3 = 'https://s3.eu-central-1.amazonaws.com/ultramsgmedia/2026/10/138500/eb79f70e619663cf3c19a3bcc0e1a240';
const realFetch = globalThis.fetch;
const sent = [];
globalThis.fetch = (url, options) => {
  const u = String(url);
  if (u.includes('api.ultramsg.com')) {
    sent.push({ url: u.replace(/token=[^&]+/, 'token=***'), body: options?.body ?? null });
    return Promise.resolve(new Response(JSON.stringify({ sent: true }), { status: 200 }));
  }
  return realFetch(url, options); // S3 + Google = REAL
};

const { default: mongoose } = await import('mongoose');
const models = await import('./backend/models/index.js');
const { Section, Subject, Teacher, TeacherMaterial, User } = models;
await mongoose.connect(process.env.MONGODB_URI);

const dept = await (await import('./backend/models/index.js')).Department.create({ name: 'Computer Science', code: 'CS' });
const sess = await (await import('./backend/models/index.js')).AcademicSession.create({ name: '2099-2100' });
const section = await Section.create({ name: '2M', semester: 2, department: dept._id, session: sess._id });
const crDoc = await User.create({ name: 'CR Test', email: 'cr@test.local', password: '$2a$10$hashhash', role: 'cr', section: section._id, phone: '+923009876543', registrationStatus: 'active', emailVerified: true });
const subject = await Subject.create({ name: 'English', code: 'ENG-201', section: section._id, createdBy: crDoc._id });
await Section.updateOne({ _id: section._id }, { $set: { cr: crDoc._id } });
const teacher = await Teacher.create({ name: 'Moid', subject: subject._id, section: section._id, whatsapp: '923078896956', createdBy: crDoc._id });

const { handleTeacherReply } = await import('./backend/services/teacherConfirmationService.js');
const t0 = Date.now();
// The webhook payload shape UltraMsg delivered for the 22:51:55 PDF (media download now ON)
const payload = {
  event_type: 'message_received', instanceId: 'instance138500',
  data: {
    id: 'false_923078896956@c.us_REPRO1', from: '923078896956@c.us', to: '923019670950@c.us',
    ack: 'pending', type: 'document', body: 'ye lo', filename: 'BS_AI_Semester_2_Lecture_2.pdf',
    mimetype: 'application/pdf', caption: 'ye lo', media: S3, fromMe: false, isForwarded: false, time: Date.now() / 1000,
  },
};
try {
  const ok = await handleTeacherReply(payload);
  console.log('consumed:', ok, '| elapsed:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  const m = await TeacherMaterial.findOne({}, {}).sort({ createdAt: -1 });
  console.log('material status:', m?.status, '| ext:', m?.ext, '| classification:', JSON.stringify(m?.classification)?.slice(0, 200));
  console.log('--- sends ---');
  for (const s of sent) console.log('  ->', s.url.replace('https://api.ultramsg.com/instance138500/', '').slice(0, 40), '|', String(s.body).slice(0, 150).replace(/\n/g, ' / '));
} catch (err) {
  console.log('THREW after', ((Date.now() - t0) / 1000).toFixed(1) + 's:', err?.stack?.split('\n').slice(0, 5).join('\n'));
}
await mongoose.disconnect(); await mongod.stop();
