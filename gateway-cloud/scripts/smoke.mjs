/**
 * Local smoke test — runs the FULL cloud gateway against an in-memory MongoDB
 * (no Atlas needed), then checks: HTTP status, QR page auth, QR rendering.
 * Stops after QR is confirmed (never sends anything — no number is scanned).
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongod = await MongoMemoryServer.create();
const uri = mongod.getUri('iubcrlms');
console.log(`🧪 In-memory Mongo up: ${uri}`);

const child = await import('node:child_process').then((c) =>
  c.spawn('node', ['src/index.js'], {
    env: {
      ...process.env,
      MONGODB_URI: uri,
      QR_SECRET: 'testsecret123',
      POLL_SECONDS: '60',
      PORT: '7890',
    },
  })
);

child.stdout.on('data', (d) => process.stdout.write(`[gw] ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`[gw:err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(`http://localhost:7890${path}`);
  return { status: res.status, body: await res.text() };
}

let ok = false;
for (let i = 0; i < 30; i += 1) {
  await sleep(2000);
  try {
    const status = await get('/');
    if (status.status !== 200) throw new Error(`status HTTP ${status.status}`);
    const j = JSON.parse(status.body);
    console.log(`[${i}] status: ${JSON.stringify(j)}`);
    if (j.mongo === 'connected' && j.qrReady) {
      const qr = await get('/qr?key=testsecret123');
      const qrBad = await get('/qr?key=WRONG');
      const nf = await get('/nope');
      console.log(`qr page: HTTP ${qr.status}, has-img=${qr.body.includes('<img')} | wrong-key: HTTP ${qrBad.status} | other: HTTP ${nf.status}`);
      if (qr.status === 200 && qr.body.includes('<img') && qrBad.status === 404 && nf.status === 404) ok = true;
      break;
    }
  } catch (e) {
    console.log(`[${i}] waiting for server… (${e.message})`);
  }
}

child.kill();
await mongod.stop();
console.log(ok ? '🟢 SMOKE PASS — HTTP + Mongo auth-state + QR sab working' : '🔴 SMOKE FAIL');
process.exit(ok ? 0 : 1);
