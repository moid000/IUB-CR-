/**
 * STEP 17 RESPONSIVE SWEEP (S1) — every key page of all three portals at
 * 390 / 768 / 1280 / 1440 px. For each (page, viewport):
 *   1. no horizontal document overflow (scrollWidth <= innerWidth + 1)
 *   2. page's content marker is visible
 *   3. navigation is reachable (mobile: drawer button OR sidebar; >=1280: sidebar)
 *   4. zero console/page errors (expected pre-login 401s excluded)
 * Run: SEED_CR=1 e2e server + frontend dev server, then this script.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/tmp/chrome-headless-shell/linux-153.0.8010.36/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = 'http://localhost:5173/frontend';
const USERS = {
  admin: { email: 'admin@local.test', password: 'Step14Admin!2026' },
  cr: { email: 'cr@local.test', password: 'CrPortal!2026' },
  student: { email: 'ali@local.test', password: 'Student!2026' },
};
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: '768', width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: '1280', width: 1280, height: 800 },
  { name: '1440', width: 1440, height: 900 },
];
/* [route, visible content marker] */
const PAGES = {
  admin: [
    ['/admin', 'Admin'],
    ['/admin/departments', 'Departments'],
    ['/admin/sessions', 'Sessions'],
    ['/admin/sections', 'Sections'],
    ['/admin/crs', 'CRs'],
    ['/admin/subjects', 'Subjects'],
    ['/admin/students', 'Students'],
  ],
  cr: [
    ['/cr', 'Welcome back'],
    ['/cr/section', 'Section'],
    ['/cr/subjects', 'Subjects'],
    ['/cr/students', 'Students'],
    ['/cr/announcements', 'Announcements'],
    ['/cr/notes', 'Notes'],
    ['/cr/assignments', 'Assignments'],
    ['/cr/timetable', 'Timetable'],
    ['/cr/attendance', 'Attendance'],
    ['/cr/marks', 'Marks'],
  ],
  student: [
    ['/student', 'Student'],
    ['/student/announcements', 'Announcements'],
    ['/student/notes', 'Notes'],
    ['/student/assignments', 'Assignments'],
    ['/student/timetable', 'Timetable'],
    ['/student/attendance', 'Attendance'],
    ['/student/marks', 'Marks'],
    ['/student/notifications', 'Notifications'],
  ],
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();

let passed = 0; let failed = 0; const failures = [];
const ok = (name, cond) => {
  if (cond) { passed++; } else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let role = 'init';
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (m.text().includes('Failed to load resource')) return;
  consoleErrors.push(`${role}: ${m.text()}`);
});
page.on('pageerror', (e) => consoleErrors.push(`${role}: pageerror ${e.message.slice(0, 120)}`));
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('/auth/me') && !r.url().includes('/attendance/sessions')) {
    consoleErrors.push(`${role}: HTTP ${r.status()} ${r.url().slice(0, 110)}`);
  }
});

const metrics = async () => page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  innerW: window.innerWidth,
  marker: document.body.innerText,
  drawerBtn: !![...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes('Open navigation menu') || b.getAttribute('aria-label') === 'Open navigation menu'),
  sidebar: !!document.querySelector('nav, aside'),
}));

for (const who of Object.keys(USERS)) {
  role = who;
  console.log(`— portal: ${who}`);
  /* fresh login per role */
  await page.setViewport(VIEWPORTS[0]);
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => { const e = document.querySelector('#email'); if (e) e.value = ''; const p = document.querySelector('#password'); if (p) p.value = ''; });
  await page.type('#email', USERS[who].email, { delay: 5 });
  await page.type('#password', USERS[who].password, { delay: 5 });
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Sign in')?.click(); });
  await sleep(1600);

  for (const [route, marker] of PAGES[who]) {
    for (const vp of VIEWPORTS) {
      await page.setViewport(vp);
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle0' });
      await sleep(450);
      const m = await metrics();
      const label = `${who} ${route} @${vp.name}`;
      ok(`${label} — no horizontal overflow`, m.scrollW <= m.innerW + 1);
      ok(`${label} — content renders ("${marker}")`, m.marker.includes(marker));
      const navOk = vp.width >= 1280 ? m.sidebar : (m.drawerBtn || m.sidebar);
      ok(`${label} — navigation reachable`, navOk);
    }
  }
  /* logout for a clean next role */
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await sleep(400);
  await page.evaluate(async () => { await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {}); });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(400);
}

ok('zero console/page errors across the sweep', consoleErrors.length === 0);
if (consoleErrors.length) console.log('  errors:', consoleErrors.slice(0, 10));

await browser.close();
console.log(`\nRESPONSIVE SWEEP: ${passed} passed, ${failed} failed`);
if (failed) { console.log('failed:'); failures.slice(0, 20).forEach((f) => console.log(` - ${f}`)); }
process.exit(failed ? 1 : 0);
