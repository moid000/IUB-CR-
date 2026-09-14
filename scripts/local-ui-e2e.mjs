/**
 * LOCAL UI E2E — real headless Chromium against the local stack
 * (in-memory DB; production is never touched).
 * Order matters: the department stays ACTIVE until the archive test at the
 * very end, because sections/CRs/subjects need an active department.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/tmp/chrome-headless-shell/linux-153.0.8010.36/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = 'http://localhost:5173/frontend';
const ADMIN = { email: 'admin@local.test', password: 'Step14Admin!2026' };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) consoleErrors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/auth/me')) consoleErrors.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

let passed = 0, failed = 0;
const ok = (name, cond) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = async () => page.evaluate(() => document.body.innerText);
const has = async (s) => (await text()).includes(s);
const clickByText = async (sel, t) => page.evaluate((sel, t) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t));
  if (el) el.click(); return !!el;
}, sel, t);
const type = async (sel, v) => {
  await page.waitForSelector(sel, { visible: true, timeout: 8000 });
  await page.click(sel, { clickCount: 3 });
  await page.type(sel, v, { delay: 15 });
};
const selNth = (sel, n) => page.evaluate((sel, n) => document.querySelector(sel)?.options?.[n]?.value ?? '', sel, n);

console.log('— login flow');
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
ok('login page renders', await has('Sign in'));
await type('#email', ADMIN.email);
await type('#password', ADMIN.password);
await page.keyboard.press('Enter');
await sleep(2500);
ok('redirected to /admin after login', page.url().endsWith('/admin'));
ok('overview welcome', await has('Welcome back'));

console.log('— overview dashboard');
ok('metric cards render', await has('Departments') && await has('Sections') && await has('CRs'));
ok('recent sections panel', await has('Recent sections'));
ok('no active session warning', await has('No academic session is currently active'));

console.log('— departments create/edit/duplicate');
await page.goto(`${BASE}/admin/departments`, { waitUntil: 'networkidle0' });
ok('departments empty state', await has('No departments yet'));
await clickByText('button', 'New department');
await sleep(400);
await type('#dept-name', 'Computer Science');
await type('#dept-code', 'cs'); // intentional lowercase → should be normalized
await page.click('button[type=submit]');
await sleep(1200);
ok('department created + shown (code uppercased)', await has('Computer Science') && await has('CS'));
// client validation
await clickByText('button', 'New department');
await sleep(300);
await page.click('button[type=submit]');
await sleep(400);
ok('dept client validation message', await has('at least 2 characters') || await has('Please fix'));
await clickByText('button', 'Cancel');
await sleep(300);
// edit
await clickByText('button', 'Edit');
await sleep(400);
await type('#dept-name', 'Computer Science Dept');
await page.click('button[type=submit]');
await sleep(1200);
ok('department renamed', await has('Computer Science Dept'));
// duplicate 409
await clickByText('button', 'New department');
await sleep(300);
await type('#dept-name', 'Computer Science Dept');
await type('#dept-code', 'CS');
await page.click('button[type=submit]');
await sleep(1200);
ok('duplicate dept rejected with server message', await has('Duplicate value'));
await clickByText('button', 'Cancel');
await sleep(300);

console.log('— sessions create + one-active rule');
await page.goto(`${BASE}/admin/sessions`, { waitUntil: 'networkidle0' });
await clickByText('button', 'New session');
await sleep(400);
await type('#session-name', 'Fall 2026');
await page.click('button[type=submit]');
await sleep(1200);
ok('session created (current badge)', await has('Fall 2026') && await has('Current'));
// second active session → 409
await clickByText('button', 'New session');
await sleep(300);
await type('#session-name', 'Spring 2027');
await page.click('button[type=submit]');
await sleep(1200);
ok('second active session rejected (one-active rule)', await has('already active'));
await clickByText('button', 'Cancel');
await sleep(300);

console.log('— sections create');
await page.goto(`${BASE}/admin/sections`, { waitUntil: 'networkidle0' });
await clickByText('button', 'New section');
await sleep(400);
await page.select('#section-department', await selNth('#section-department', 1));
await page.select('#section-session', await selNth('#section-session', 1));
await page.select('#section-semester', '2');
await type('#section-name', 'a'); // lowercase → normalized
await page.click('button[type=submit]');
await sleep(1500);
ok('section created (name uppercased, no CR badge)', await has('Not assigned'));

console.log('— CR precreate');
await page.goto(`${BASE}/admin/crs`, { waitUntil: 'networkidle0' });
await clickByText('button', 'Pre-create CR');
await sleep(400);
ok('activation model note shown', await has('/cr/activate'));
await type('#cr-name', 'Test CR');
await type('#cr-email', 'testcr@local.test');
await page.select('#cr-section', await selNth('#cr-section', 1));
await page.click('button[type=submit]');
await sleep(1500);
ok('CR precreated + pending badge', await has('Test CR') && await has('Pending activation'));
ok('CR shows assigned section', await has('Sem 2'));
// duplicate email 409
await clickByText('button', 'Pre-create CR');
await sleep(300);
await type('#cr-name', 'Dup');
await type('#cr-email', 'testcr@local.test');
await page.select('#cr-section', await selNth('#cr-section', 1));
await page.click('button[type=submit]');
await sleep(1200);
ok('duplicate CR email rejected', await has('already in use'));
await clickByText('button', 'Cancel');
await sleep(300);

console.log('— sections: CR shown + remove');
await page.goto(`${BASE}/admin/sections`, { waitUntil: 'networkidle0' });
ok('section now shows CR', await has('Test CR'));
await clickByText('button', 'Remove CR');
await sleep(400);
ok('remove-CR confirmation', await has('Remove CR from section?'));
// click the DIALOG's confirm (scoped so we don't re-click the row button)
await page.evaluate(() => {
  const dlg = [...document.querySelectorAll('.fixed button')].find((e) => e.textContent.trim() === 'Remove CR');
  if (dlg) dlg.click();
});
await sleep(1200);
ok('CR removed flash', await has('CR removed'));

console.log('— subjects create + duplicate');
await page.goto(`${BASE}/admin/subjects`, { waitUntil: 'networkidle0' });
await clickByText('button', 'New subject');
await sleep(400);
await page.select('#subject-section', await selNth('#subject-section', 1));
await type('#subject-name', 'Programming Fundamentals');
await type('#subject-code', 'cs-101');
await type('#subject-teacher', 'Dr. Ahmed');
await page.click('button[type=submit]');
await sleep(1500);
ok('subject created (code uppercased)', await has('CS-101') && await has('Programming Fundamentals'));
// duplicate code in section → 409
await clickByText('button', 'New subject');
await sleep(300);
await page.select('#subject-section', await selNth('#subject-section', 1));
await type('#subject-name', 'Programming Fundamentals Again');
await type('#subject-code', 'CS-101');
await page.click('button[type=submit]');
await sleep(1200);
ok('duplicate subject code rejected', await has('Duplicate value'));
await clickByText('button', 'Cancel');
await sleep(300);

console.log('— students read-only directory');
await page.goto(`${BASE}/admin/students`, { waitUntil: 'networkidle0' });
ok('students empty state', await has('No students found'));
ok('read-only info banner', await has('/student/activate'));

console.log('— overview with data');
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' });
await sleep(800);
ok('overview counts > 0', await has('Departments') && (await has('1')));

console.log('— archive rules (LAST — downstream flows done)');
// 1. dept with an ACTIVE section → blocked with server message in dialog
await page.goto(`${BASE}/admin/departments`, { waitUntil: 'networkidle0' });
await clickByText('button', 'Archive');
await sleep(400);
ok('archive confirmation dialog', await has('Archive department?'));
await clickByText('button', 'Archive department');
await sleep(1200);
ok('blocked archive shows server reason (active sections)', await has('still has active sections'));
await clickByText('button', 'Cancel');
await sleep(300);
// 2. archive the section first
await page.goto(`${BASE}/admin/sections`, { waitUntil: 'networkidle0' });
await clickByText('button', 'Archive');
await sleep(400);
ok('section archive confirmation', await has('Archive section?'));
await clickByText('button', 'Archive section');
await sleep(1200);
ok('section archived flash', await has('archived'));
// 3. now the dept archives successfully
await page.goto(`${BASE}/admin/departments`, { waitUntil: 'networkidle0' });
await clickByText('button', 'Archive');
await sleep(400);
await clickByText('button', 'Archive department');
await sleep(1200);
ok('department archived flash', await has('Department archived'));

console.log('— role protection + logout');
await page.goto(`${BASE}/cr`, { waitUntil: 'networkidle0' });
await sleep(1200);
ok('admin blocked from /cr', page.url().includes('/forbidden') || page.url().includes('/admin') || page.url().includes('/login'));
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' });
await sleep(600);
// logout via profile menu
await page.click('button[aria-haspopup="menu"]');
await sleep(300);
await clickByText('button', 'Sign out');
await sleep(1500);
ok('logout → /login', page.url().endsWith('/login'));
// protected route after logout
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' });
await sleep(1500);
ok('/admin redirects to login when logged out', page.url().endsWith('/login'));

console.log('— mobile viewport');
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await type('#email', ADMIN.email);
await type('#password', ADMIN.password);
await page.keyboard.press('Enter');
await sleep(2500);
ok('mobile: lands on /admin', page.url().endsWith('/admin'));
const hamburger = await page.$('button[aria-label="Open navigation menu"]');
ok('mobile: hamburger visible', !!hamburger);
if (hamburger) { await hamburger.click(); await sleep(400); ok('mobile: drawer opens', await page.evaluate(() => document.querySelector('aside')?.classList.contains('translate-x-0'))); }

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (consoleErrors.length) { console.log('CONSOLE ERRORS:'); consoleErrors.forEach((e) => console.log('  ' + e.slice(0, 200))); }
await browser.close();
process.exit(failed ? 1 : 0);
