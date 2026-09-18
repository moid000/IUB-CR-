/** Smoke test for the SERVERLESS gateway handlers (in-memory Mongo, no network). */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri('iubcrlms');
process.env.SWEEP_SECRET = 'sweeptest';
process.env.QR_SECRET = 'qrtest';

console.log('🧪 In-memory Mongo up');

const sweep = (await import('../api/sweep.js')).default;
const status = (await import('../api/status.js')).default;
const pair = (await import('../api/pair.js')).default;

function mockRes() {
  const r = { statusCode: 200, body: '', headers: {},
    setHeader(k, v) { r.headers[k] = v; },
    write(c) { r.body += c; },
    end(c) { if (c) r.body += c; r.done = true; } };
  r.done = false;
  return r;
}
const mockReq = (path) => ({ url: path, query: Object.fromEntries(new URL(path, 'http://x').searchParams), headers: {} });

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`); } };

// 1) sweep: unauthorized without key
let res = mockRes();
await sweep(mockReq('/api/sweep'), res);
check('sweep 401 without key', res.statusCode === 401 && res.body.includes('unauthorized'));

// 2) sweep: idle (no due) — needs a registered session to report paired
const { WaStore, Assignment } = await import('../src/models.js');
await mongoose.connect(process.env.MONGODB_URI);
await WaStore.create({ _id: 'creds', v: JSON.stringify({ registered: true }) });
res = mockRes();
await sweep(mockReq('/api/sweep?key=sweeptest'), res);
const j = JSON.parse(res.body);
check('sweep idle ok', res.statusCode === 200 && j.ok === true && j.due === 0 && j.idle === true);
check('sweep reports paired', j.paired === true);

// 3) status: paired true
res = mockRes();
await status(mockReq('/api/status?key=qrtest'), res);
const st = JSON.parse(res.body);
check('status paired', res.statusCode === 200 && st.paired === true);

// 4) pair: already paired page
res = mockRes();
await pair(mockReq('/api/pair?key=qrtest'), res);
check('pair already-paired page', res.statusCode === 200 && res.body.includes('Already paired'));

// 5) pair: no phone → phone form
await WaStore.findByIdAndDelete('creds');
res = mockRes();
await pair(mockReq('/api/pair?key=qrtest'), res);
check('pair phone form', res.statusCode === 200 && res.body.includes('Get pairing code'));

// 6) pair: bad phone → invalid page (no socket handshake needed for these paths)
res = mockRes();
await pair(mockReq('/api/pair?key=qrtest&phone=123'), res);
check('pair invalid number', res.statusCode === 200 && res.body.includes('Invalid number'));

// 7) sweep: unpaired + due → loud error, claims untouched
await Assignment.create({ title: 'T', status: 'published', deadline: new Date(), deadlineNotifiedAt: null });
res = mockRes();
await sweep(mockReq('/api/sweep?key=sweeptest'), res);
const j2 = JSON.parse(res.body);
check('sweep unpaired-due loud error', j2.due === 1 && j2.paired === false && /not paired/.test(j2.error || ''));
const untouched = await Assignment.findOne({ title: 'T' });
check('claim untouched when unpaired', untouched.deadlineNotifiedAt === null);

// 8) pair: unauthorized without key
res = mockRes();
await pair(mockReq('/api/pair'), res);
check('pair 401 without key', res.statusCode === 401);

console.log(`\n${pass} passed, ${fail} failed`);
await mongoose.disconnect();
await mongod.stop();
process.exit(fail ? 1 : 0);
