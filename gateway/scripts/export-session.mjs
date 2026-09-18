/**
 * ONE-TIME: export the laptop gateway's paired WhatsApp session (./auth
 * multi-file state) into the CLOUD gateway's MongoDB wa_store via
 * /api/import-session. After this, the cloud (Vercel) runs 24/7 sends and
 * the laptop can stay off.
 *
 * Why: WhatsApp may refuse companion linking from datacenter IPs (sandbox/
 * Vercel), and code-entry races are painful on one phone. Pairing from the
 * laptop (home/mobile network IP, QR scan from the laptop screen) is the
 * natural flow; this script then moves the session to the cloud.
 *
 * The repo is PUBLIC — the secret import URL is passed on the command line:
 *
 *   node scripts/export-session.mjs "https://iubcr-gateway.vercel.app/api/import-session?key=<QR_SECRET>"
 *
 * (get the URL with key from the agent chat)
 */
import fs from 'node:fs';
import path from 'node:path';

const AUTH_DIR = path.join(process.cwd(), 'auth');
const url = process.argv[2];

if (!url || !url.includes('key=')) {
  console.error('Usage: node scripts/export-session.mjs "<import-url-with-key>"');
  process.exit(1);
}
const credsPath = path.join(AUTH_DIR, 'creds.json');
if (!fs.existsSync(credsPath)) {
  console.error('auth/creds.json nahi mila — pehle `npm start` kar ke QR scan karo,');
  console.error('phir "Connected" hone ke baad Ctrl+C kar ke ye script chalao.');
  process.exit(1);
}

const creds = fs.readFileSync(credsPath, 'utf8');
if (!creds.includes('"registered":true')) {
  console.error('WARNING: creds registered nahi lagta — QR scan pakka complete hua?');
}

// Cloud wa_store key doc ids are `key-<name>-<idx>`; useMultiFileAuthState
// stores them as plain `<name>-<idx>.json` files — so prefix 'key-'.
const keys = {};
for (const f of fs.readdirSync(AUTH_DIR)) {
  if (!f.endsWith('.json') || f === 'creds.json') continue;
  keys[`key-${f.replace(/\.json$/, '')}`] = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
}

console.log(`Exporting: creds + ${Object.keys(keys).length} key docs…`);
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ creds, keys }),
});
const j = await res.json().catch(() => ({}));
console.log('IMPORT RESULT:', res.status, JSON.stringify(j));
if (res.ok && j.ok) {
  console.log('✅ Cloud gateway ab paired hai! Laptop band kar sakte ho.');
} else {
  console.log('❌ Import fail hua — agent ko ye result bhejo.');
}
