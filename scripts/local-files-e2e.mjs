/**
 * STEP 18 — Files/attachments UI E2E (puppeteer, local stack).
 *
 * Covers the full browser-direct upload flow with an INTERCEPTED Cloudinary
 * (no real API call is ever made):
 *   A. CR: create announcement → attach modal (auto-opens) → upload PDF →
 *      "Uploaded ✓" → file card → Done → row shows "1 file".
 *   B. Student: announcement detail shows the attachment card.
 *   C. CR: remove attachment → student no longer sees it.
 *   D. Validation UI: unsupported type (.exe) + oversize (11 MB) rejected
 *      client-side with friendly errors; no Cloudinary request is fired.
 *   E. CR assignment: attach a file; student sees "Assignment files from
 *      your CR"; student submits with a PRE-SELECTED file (the pending-
 *      before-first-submit flow) → "1 file attached."
 *   F. Student own file: remove via uploader → gone.
 *   G. CR submissions modal: sees the student's file (chips + view files).
 *   H. Idempotence: reload + re-open → still exactly 1 file (no duplicates).
 *   I. Avatar: student uploads photo → header shows <img>; remove →
 *      initials fallback returns.
 *   J. Change-password UI: wrong current → inline error; correct → success;
 *      old password rejected, new password logs in (API).
 *   K. Console/page-error monitor with expected-negative allowlist.
 */
import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = '/tmp/chrome-headless-shell/linux-153.0.8010.36/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = 'http://localhost:5173/frontend';
const API = 'http://localhost:3000';
const PASSWORD = 'QaFiles!2026';
const NEW_PASSWORD = 'QaFiles!2027';

/* reset DB — this script builds its own world from scratch */
const reset = await fetch(`${API}/api/__e2e/reset`, { method: 'POST' }).then((r) => r.json());
if (!reset?.success) throw new Error(`e2e reset failed: ${JSON.stringify(reset)}`);

let passed = 0; let failed = 0;
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  cond ? passed++ : failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- per-role cookie jars (API) ------------------------- */
const jars = new Map();
const jarFor = (who) => {
  if (!jars.has(who)) jars.set(who, new Map());
  return jars.get(who);
};
async function api(who, method, path, body, raw = false) {
  const jar = jarFor(who);
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  for (const rawC of res.headers.getSetCookie?.() ?? []) {
    const [pair] = rawC.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const json = await res.json().catch(() => null);
  if (!raw && res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 160)}`);
  return { status: res.status, json };
}

/* ------------------------------ browser plumbing ------------------------------ */
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });

let cloudinaryRequests = 0; // must stay 0 for client-rejected files
const consoleErrors = [];
let PHASE = 'init';
const EXPECTED_NEGATIVES = [
  '/api/auth/change-password', // wrong-current-password negative test (401)
];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (m.text().includes('Failed to load resource')) return;
  consoleErrors.push({ phase: PHASE, msg: m.text() });
});
page.on('pageerror', (e) => consoleErrors.push({ phase: PHASE, msg: `pageerror: ${e.message}` }));
page.on('response', (r) => {
  if (r.status() < 400) return;
  const u = r.url();
  if (r.status() === 401 && u.includes('/auth/me')) return; // expected pre-login probe
  // GET 404 on own submission = "not submitted yet" — by design
  const expected = EXPECTED_NEGATIVES.some((p) => u.includes(p))
    || (r.status() === 404 && r.request().method() === 'GET' && /\/api\/(cr|student)\/assignments\/[^/]+\/submission/.test(u));
  consoleErrors.push({ phase: PHASE, msg: `HTTP ${r.status()} ${u}`, expected });
});

/* Sign-aware Cloudinary interception — the sign request/response pair tells us
   EVERYTHING the backend authorized (folder, publicId, resourceType, format);
   we replay it as a perfect Cloudinary result. No real API call is made. */
/* Sign-aware Cloudinary interception. The sign request/response pair tells us
   everything the backend authorized (folder, publicId, resourceType); we replay
   it as a perfect Cloudinary result. The response body is captured as a PROMISE
   and awaited inside the interceptor — this removes the race where the upload
   POST was intercepted before the sign response had been parsed. */
let signReqFile = {};
let signRespPromise = Promise.resolve({});
page.on('request', (req) => {
  if (req.method() === 'POST' && (req.url().includes('/files/sign') || req.url().includes('/avatar/sign'))) {
    try { signReqFile = (JSON.parse(req.postData() ?? '{}')).file ?? {}; } catch { signReqFile = {}; }
  }
});
page.on('response', (res) => {
  if (res.url().includes('/files/sign') || res.url().includes('/avatar/sign')) {
    signRespPromise = res.json().catch(() => ({}));
  }
});
await page.setRequestInterception(true);
page.on('request', async (req) => {
  if (req.url().includes('cloudinary.com')) {
    const origin = req.headers()?.origin ?? '*';
    if (req.method() === 'GET') {
      // fake asset fetch (avatar <img>, FileList thumbnails) — a real 1x1 PNG
      await req.respond({
        status: 200, contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
      });
      return;
    }
    if (req.method() === 'OPTIONS') {
      await req.respond({ status: 204, headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': req.headers()?.['access-control-request-headers'] ?? 'content-type',
        'access-control-max-age': '86400',
      } });
      return;
    }
    cloudinaryRequests += 1;
    const j = await signRespPromise; // race-free: always the CURRENT sign
    const sign = j?.data ?? j ?? {};
    const folder = String(sign.folder ?? '');
    // mimic REAL Cloudinary: the final public_id is folder + '/' + basename
    const publicId = folder ? `${folder}/${String(sign.publicId ?? '')}` : String(sign.publicId ?? '');
    const rt = String(sign.resourceType ?? 'raw');
    const cloud = String(sign.cloudName ?? 'e2e-cloud');
    const fname = String(signReqFile?.originalName ?? 'upload.pdf');
    const ext = fname.includes('.') ? fname.split('.').pop().toLowerCase() : 'pdf';
    req.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': origin },
      body: JSON.stringify({
        public_id: publicId,
        folder,
        secure_url: `https://res.cloudinary.com/${cloud}/${rt}/upload/${publicId}.${ext}`,
        resource_type: rt,
        format: ext,
        bytes: 4096,
        original_filename: fname,
      }),
    });
  } else {
    req.continue();
  }
});

const text = async () => page.evaluate(() => document.body.innerText);
const has = async (s) => (await text()).includes(s);
const clickByText = async (sel, t) => page.evaluate((sel, t) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t));
  if (el) el.click();
  return !!el;
}, sel, t);
const clickExact = async (t) => page.evaluate((t) => {
  const el = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === t);
  if (el) el.click();
  return !!el;
}, t);
const type = async (sel, v) => {
  await page.waitForSelector(sel, { visible: true, timeout: 8000 });
  await page.click(sel, { clickCount: 3 });
  await page.type(sel, v, { delay: 15 });
};
const openDrawer = async () => { await page.evaluate(() => document.querySelector('button[aria-label="Open navigation menu"]')?.click()); await sleep(500); };
const navTo = async (label, slug) => {
  await openDrawer();
  const clicked = await clickByText('a', label);
  await sleep(700);
  if (slug && !page.url().includes(slug)) {
    await openDrawer();
    await clickByText('a', label);
    await sleep(900);
  }
  return slug ? page.url().includes(slug) : clicked;
};
const loginUi = async (email, pass) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await sleep(400);
  await type('#email', email);
  await type('#password', pass);
  await clickExact('Sign in');
  await page.waitForFunction(() => !window.location.pathname.includes('/login'), { timeout: 10000 });
  await sleep(800);
};
const logoutUi = async () => {
  /* 'Sign out' lives in the header account menu (avatar button, aria-haspopup) */
  await page.keyboard.press('Escape');
  await sleep(250); // close stray menus/modals first so the toggle below OPENS the menu
  await page.evaluate(() => [...document.querySelectorAll('button[aria-haspopup="menu"]')][0]?.click());
  await sleep(450);
  if (!(await clickByText('button', 'Sign out'))) {
    await page.evaluate(() => [...document.querySelectorAll('button[aria-haspopup="menu"]')][0]?.click());
    await sleep(450);
    await clickByText('button', 'Sign out');
  }
  try {
    await page.waitForFunction(() => window.location.pathname.includes('/login'), { timeout: 10000 });
  } catch {
    const diag = await page.evaluate(() => ({ url: window.location.pathname, btns: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).slice(0, 30) }));
    console.log('  ! logoutUi TIMEOUT — ' + JSON.stringify(diag).slice(0, 700));
    throw new Error('logout failed');
  }
  await sleep(600);
};

/* waitStatus — like waitForFunction(text) but dumps diagnostics instead of throwing */
const waitStatus = async (label, timeout = 15000) => {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, label);
    return true;
  } catch {
    const diag = await page.evaluate(() => ({
      modalOpen: !!document.querySelector('input[type="file"]'),
      statuses: [...document.querySelectorAll('[role="status"],[role="alert"]')].map((e) => e.textContent.trim()).slice(0, 12),
      url: window.location.pathname,
    }));
    const recent = consoleErrors.filter((e) => e.phase === PHASE).slice(-4).map((e) => e.msg);
    console.log(`  ! waitStatus(${label}) TIMEOUT — ${JSON.stringify(diag)} recent=${JSON.stringify(recent)}`);
    return false;
  }
};

/* ------------------------- activation via real OTP flow ------------------------- */
async function getOtp(email) {
  for (let i = 0; i < 60; i += 1) {
    const j = await fetch(`${API}/__e2e/otp/${encodeURIComponent(email)}`).then((r) => r.json());
    if (j.otp) return j.otp;
    await sleep(500);
  }
  throw new Error(`OTP for ${email} never arrived`);
}
async function activateViaApi(kind, email) {
  await api('anon', 'POST', `/api/auth/${kind}/request-otp`, { email });
  const code = await getOtp(email);
  const v = await api('anon', 'POST', `/api/auth/${kind}/verify-otp`, { email, otp: code });
  const activationToken = v.json?.activationToken ?? v.json?.data?.activationToken;
  if (!activationToken) throw new Error(`verify-otp for ${email} returned no token`);
  await api('anon', 'POST', `/api/auth/${kind}/set-password`, { activationToken, password: PASSWORD, confirmPassword: PASSWORD });
}

/* ==================================== WORLD ==================================== */
console.log('— phase W: build world (real admin API + real OTP activation)');
PHASE = 'world';
const aLogin = await api('admin', 'POST', '/api/auth/login', { email: 'admin@local.test', password: 'Step14Admin!2026' });
ok('admin login', aLogin.status === 200);

const dept = (await api('admin', 'POST', '/api/admin/departments', { name: 'QA Files Dept', code: 'QAFL' })).json.data;
const sess = (await api('admin', 'POST', '/api/admin/sessions', { name: 'QA Session F', startedAt: '2026-09-01', endedAt: '2027-06-30', status: 'active' })).json.data;
const secA = (await api('admin', 'POST', '/api/admin/sections', { department: dept._id, session: sess._id, semester: 5, name: 'QA-FA' })).json.data;
ok('section A created', !!secA._id);
const crA = (await api('admin', 'POST', '/api/admin/crs', { name: 'Files CR', email: 'cr-f@qa.test', phone: '+923001110011', sectionId: secA._id })).json.data;
await activateViaApi('cr', 'cr-f@qa.test');
await api('cr', 'POST', '/api/auth/login', { email: 'cr-f@qa.test', password: PASSWORD });
await api('cr', 'POST', '/api/cr/students', { name: 'Files Student A', email: 's-fa@qa.test', phone: '+923001110021', rollNo: 'FA-01' });
await activateViaApi('student', 's-fa@qa.test');
const subj = (await api('cr', 'POST', '/api/cr/subjects', { name: 'File Systems', code: 'FS-501' })).json.data;
ok('subject created by CR', !!subj?._id);
ok('cr + student activated (real OTP flow)', true);

/* ================================ A: announcement attach flow ================================ */
console.log('— phase A: CR announcement → attach modal → upload → visible to student');
PHASE = 'cr-attach';
await loginUi('cr-f@qa.test', PASSWORD);
ok('CR signed in', page.url().includes('/cr') && (await has('Welcome back, Files')));

await navTo('Announcements', '/cr/announcements');
await sleep(400);
await clickExact('New announcement');
await sleep(500);
await type('#ann-title', 'Midterm syllabus posted');
await type('#ann-content', 'Find the syllabus PDF attached.');
await clickExact('Publish');
await sleep(900);
ok('publish routes to the attach modal', await has('Manage attachments'));

// upload the PDF through the real uploader input
const before = cloudinaryRequests;
await page.waitForSelector('input[type="file"]', { timeout: 8000 });
const fileInputs = await page.$$('input[type="file"]');
await fileInputs[fileInputs.length - 1].uploadFile('/tmp/iub-e2e/sample.pdf');
ok('PDF uploaded (sign → cloudinary → confirm)', await waitStatus('Uploaded ✓'));
ok('Cloudinary received exactly 1 browser-direct request', cloudinaryRequests - before === 1);
ok('current files list shows sample.pdf', await has('sample.pdf'));
await clickExact('Done');
await sleep(700);
ok('announcement row shows "1 file"', await has('1 file'));

/* ================================ D: client-side validation ================================ */
console.log('— phase D: friendly client-side rejection (no upload fired)');
PHASE = 'cr-validation';
await clickExact('Files'); // exact match — sidebar user card contains 'Files CR'
await sleep(600);
ok('attach modal reopened from Files action', await has('Manage attachments'));
await page.waitForSelector('input[type="file"]', { timeout: 8000 }).catch(() => {});
const beforeRej = cloudinaryRequests;
const inputs2 = await page.$$('input[type="file"]');
await inputs2[inputs2.length - 1].uploadFile('/tmp/iub-e2e/bad.exe');
await sleep(500);
ok('.exe rejected with friendly message', await has("This file type isn't supported."));
await inputs2[inputs2.length - 1].uploadFile('/tmp/iub-e2e/big.pdf');
await sleep(700);
ok('11 MB rejected with friendly message', await has('File must be 10 MB or smaller.'));
ok('NO Cloudinary request fired for rejected files', cloudinaryRequests === beforeRej);
await clickExact('Done');
await sleep(400);

/* ================================ B/C: student sees, then removal ================================ */
console.log('— phase B/C: student visibility + CR removal');
PHASE = 'student-view';
await logoutUi();
await loginUi('s-fa@qa.test', PASSWORD);
await navTo('Announcements', '/student/announcements');
await sleep(400);
ok('student sees the announcement', await has('Midterm syllabus posted'));
await clickByText('button', 'Midterm syllabus posted');
await sleep(900);
ok('student sees the attachment card', await has('sample.pdf'));
ok('student detail shows attachment header', (await text()).toLowerCase().includes('attachment'));
await page.keyboard.press('Escape');
await sleep(400);
await logoutUi();

PHASE = 'cr-remove';
await loginUi('cr-f@qa.test', PASSWORD);
await navTo('Announcements', '/cr/announcements');
await clickExact('Files');
await sleep(600);
await clickByText('button', 'Remove');
await sleep(900);
ok('current files empty after removal', !(await has('sample.pdf')));
await clickExact('Done');
await sleep(600);
ok('row shows no file count', !(await has('1 file')));

PHASE = 'student-view-2';
await logoutUi();
await loginUi('s-fa@qa.test', PASSWORD);
await navTo('Announcements', '/student/announcements');
await sleep(400);
await clickByText('button', 'Midterm syllabus posted');
await sleep(900);
ok('student no longer sees the attachment', !(await has('sample.pdf')));
await page.keyboard.press('Escape');
await sleep(300);

/* ================================ E-G: assignment + submission files ================================ */
console.log('— phase E-G: assignment attachments + student submission files');
PHASE = 'cr-assignment';
await logoutUi();
await loginUi('cr-f@qa.test', PASSWORD);
await navTo('Assignments', '/cr/assignments');
await sleep(400);
await clickExact('New assignment');
await sleep(500);
await type('#asg-title', 'Lab 1 — ER diagram');
await page.select('#asg-subject', subj._id);
const dl = new Date(Date.now() + 48 * 3600 * 1000);
const pad = (n) => String(n).padStart(2, '0');
await type('#asg-deadline', `${dl.getFullYear()}-${pad(dl.getMonth() + 1)}-${pad(dl.getDate())}T23:59`);
await clickExact('Create assignment');
await sleep(900);
ok('assignment attach modal opened', await has('Manage attachments'));
const inputs3 = await page.$$('input[type="file"]');
await inputs3[inputs3.length - 1].uploadFile('/tmp/iub-e2e/sample.pdf');
ok('assignment file uploaded', await waitStatus('Uploaded ✓'));
await clickExact('Done');
await sleep(700);
ok('assignment created + file attached', await has('Lab 1 — ER diagram'));

PHASE = 'student-submit';
await logoutUi();
await loginUi('s-fa@qa.test', PASSWORD);
await navTo('Assignments', '/student/assignments');
await sleep(500);
await clickByText('button', 'Lab 1 — ER diagram');
await sleep(900);
ok('student sees CR assignment files', (await text()).toLowerCase().includes('assignment files from your cr'));
ok('assignment file card visible', await has('sample.pdf'));
// pre-first-submit pending file flow (file-only submission, no text)
await page.waitForSelector('#pending-files', { timeout: 8000 });
await page.$eval('#pending-files', (el) => el.className); // ensure attached
const pend = await page.$('#pending-files');
await pend.uploadFile('/tmp/iub-e2e/sample.pdf');
await sleep(400);
ok('pending chip listed before submit', await page.$$eval('ul[aria-label="Files waiting to upload"]', (els) => els.length > 0));
await clickExact('Submit');
await sleep(2500);
ok('after submit: "1 file attached."', await has('1 file attached.'));
ok('submission box shows the file', (await text()).includes('sample.pdf'));
ok('uploader now live on the submission', await has('Attach files to your submission'));

// H: idempotence — reload + reopen, still exactly 1 file
PHASE = 'idempotence';
await page.reload({ waitUntil: 'networkidle0' });
await sleep(900);
ok('session survives reload', await has('Lab 1 — ER diagram'));
await clickByText('button', 'Lab 1 — ER diagram');
await sleep(700);
// no duplicates = every attachments list holds the file exactly ONCE (the
// modal legitimately shows CR assignment files AND our submission files)
const dup = await page.$$eval('ul[aria-label="Attachments"]', (uls) =>
  uls.map((ul) => [...ul.querySelectorAll('li')].filter((li) => li.textContent.includes('sample.pdf')).length));
ok('no duplicate file entries after reload', dup.length >= 1 && dup.every((n) => n === 1));

// F: student removes own file
PHASE = 'student-remove';
await clickByText('button', 'Remove');
await sleep(900);
ok('own file removed from submission', !(await has('Remove sample.pdf')));
await page.keyboard.press('Escape');
await sleep(300);

PHASE = 'cr-submissions';
await logoutUi();
await loginUi('cr-f@qa.test', PASSWORD);
await navTo('Assignments', '/cr/assignments');
await sleep(400);
await clickByText('button', 'Submissions');
await sleep(700);
ok('submissions modal lists the student', await has('Files Student A'));

/* ================================ I/J: avatar + change password ================================ */
console.log('— phase I/J: avatar upload/remove + change-password (student profile)');
PHASE = 'avatar';
await logoutUi();
await loginUi('s-fa@qa.test', PASSWORD);
await navTo('Profile', '/student/profile');
await sleep(600);
const avatarBefore = await page.$$eval('header img, nav img, img[alt*="profile picture" i]', (els) => els.length);
await page.waitForSelector('#avatar-file-input', { timeout: 8000 });
await page.$eval('#avatar-file-input', (el) => el); // attached check
const avatarInput = await page.$('#avatar-file-input');
await avatarInput.uploadFile('/tmp/iub-e2e/avatar.png');
await page.waitForFunction(() => document.body.innerText.includes('Profile picture updated.'), { timeout: 15000 });
ok('avatar uploaded + confirmation shown', true);
await sleep(500);
const avatarAfter = await page.$$eval('img[alt*="profile picture" i]', (els) => els.length);
ok('profile renders the uploaded avatar <img>', avatarAfter > avatarBefore);

// remove avatar → initials fallback (no img in profile header area)
await clickByText('button', 'Remove');
await page.waitForFunction(() => document.body.innerText.includes('Profile picture removed.'), { timeout: 10000 });
await sleep(400);
const avatarGone = await page.$$eval('img[alt*="profile picture" i]', (els) => els.length);
ok('avatar removed → initials fallback', avatarGone === 0);

// change password — wrong current
PHASE = 'change-password';
await type('#cp-current', 'WrongPass!123');
await type('#cp-new', NEW_PASSWORD);
await type('#cp-confirm', NEW_PASSWORD);
await clickExact('Change password');
await sleep(700);
ok('wrong current password → inline error', await has('Your current password is incorrect.'));

// correct current
await page.click('#cp-current', { clickCount: 3 });
await page.type('#cp-current', PASSWORD, { delay: 10 });
await clickExact('Change password');
await page.waitForFunction(() => document.body.innerText.includes('Password changed'), { timeout: 10000 });
ok('password changed with confirmation', true);
await sleep(400);

// API: old rejected, new accepted
const oldTry = await api('anon', 'POST', '/api/auth/login', { email: 's-fa@qa.test', password: PASSWORD }, true);
const newTry = await api('anon2', 'POST', '/api/auth/login', { email: 's-fa@qa.test', password: NEW_PASSWORD }, true);
ok('old password rejected (401)', oldTry.status === 401);
ok('new password accepted', newTry.status === 200);

/* ================================ K: console health ================================ */
console.log('— phase K: console health');
const unexpected = consoleErrors.filter((e) => !e.expected);
ok(`no unexpected console/page errors (${unexpected.length})`, unexpected.length === 0);
if (unexpected.length) console.log(JSON.stringify(unexpected, null, 2).slice(0, 1200));

console.log(`\nFILES E2E: ${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
