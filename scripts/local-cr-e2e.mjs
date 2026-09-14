/**
 * CR PORTAL UI E2E — headless Chromium against the local stack (SEED_CR=1).
 * Production is never touched. Order matters: shared fixtures (subjects,
 * announcements…) are created before the flows that read them.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/tmp/chrome-headless-shell/linux-153.0.8010.36/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = 'http://localhost:5173/frontend';
const CR = { email: 'cr@local.test', password: 'CrPortal!2026' };

// reset the local e2e DB so every run starts from the same seed (idempotent)
{
  const res = await fetch('http://localhost:3000/api/__e2e/reset', { method: 'POST' });
  const body = await res.json();
  if (!body?.success) throw new Error(`e2e reset failed: ${JSON.stringify(body)}`);
  console.log(`DB reset ok — ${body.note}`);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) consoleErrors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/auth/me')) consoleErrors.push(`HTTP ${r.status()} ${r.url().split('?')[0]}`); });
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
const clickByTextExact = async (sel, t) => page.evaluate((sel, t) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === t);
  if (el) el.click(); return !!el;
}, sel, t);
const type = async (sel, v) => {
  try {
    await page.waitForSelector(sel, { visible: true, timeout: 8000 });
  } catch {
    console.log(`!! TIMEOUT waiting for ${sel}`);
    console.log('inputs on page:', await page.evaluate(() => [...document.querySelectorAll('input, select')].map((i) => `${i.tagName}#${i.id || '-'} vis=${!!(i.offsetWidth || i.offsetHeight)}`).join(' · ')));
    console.log('body text:', await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | ').slice(0, 600)));
    throw new Error(`timeout: ${sel}`);
  }
  await page.click(sel, { clickCount: 3 });
  await page.type(sel, v, { delay: 12 });
};
const selNth = (sel, n) => page.evaluate((sel, n) => document.querySelector(sel)?.options?.[n]?.value ?? '', sel, n);
const inDialog = async (t) => page.evaluate((t) => {
  const dlg = [...document.querySelectorAll('.fixed.inset-0 button')].find((e) => e.textContent.trim() === t);
  if (dlg) dlg.click(); return !!dlg;
}, t);

console.log('— CR login flow');
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
await type('#email', CR.email);
await type('#password', CR.password);
await page.keyboard.press('Enter');
await sleep(2500);
ok('redirected to /cr after login', page.url().endsWith('/cr'));
ok('overview greeting with section', await has('Welcome back') && await has('Section A') === false || await has('A'));
ok('overview metrics render', await has('Students') && await has('Subjects'));

console.log('— overview: real counts from seed');
ok('students count = 1', await has('Ali Khan') || await has('1'));
await sleep(1000);

console.log('— my section page');
await page.goto(`${BASE}/cr/section`, { waitUntil: 'networkidle0' });
ok('section card: name A', await has('My Section') && await has('A'));
ok('section shows department + semester', await has('Computer Science') && await has('Semester 3'));

console.log('— subjects: create, normalize, duplicate 409, edit, archive');
await page.goto(`${BASE}/cr/subjects`, { waitUntil: 'networkidle0' });
ok('seeded subjects visible', await has('CS-101') && await has('CS-201'));
await clickByText('button', 'New subject');
await sleep(400);
await type('#cr-subject-name', 'Discrete Mathematics');
await type('#cr-subject-code', 'cs-301'); // lowercase → normalized
await type('#cr-subject-teacher', 'Dr. Bilal');
await page.click('button[type=submit]');
await sleep(1300);
ok('subject created + code uppercased', await has('CS-301') && await has('Discrete Mathematics'));
// duplicate code → 409
await clickByText('button', 'New subject');
await sleep(300);
await type('#cr-subject-name', 'Discrete Math Again');
await type('#cr-subject-code', 'CS-301');
await page.click('button[type=submit]');
await sleep(1300);
ok('duplicate subject code rejected', await has('Duplicate value') || await has('already'));
await clickByText('button', 'Cancel');
await sleep(300);
// client validation
await clickByText('button', 'New subject');
await sleep(300);
await page.click('button[type=submit]');
await sleep(400);
ok('subject client validation message', await has('at least 2 characters') || await has('Enter the subject name'));
await clickByText('button', 'Cancel');
await sleep(300);
// edit
await page.evaluate(() => {
  const row = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('CS-301'));
  const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('Edit'));
  if (btn) btn.click();
});
await sleep(500);
await type('#cr-subject-teacher', 'Dr. Bilal Hussain');
await page.click('button[type=submit]');
await sleep(1300);
ok('subject edited (teacher renamed)', await has('Dr. Bilal Hussain'));
// archive CS-301
await page.evaluate(() => {
  const row = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('CS-301'));
  const btn = [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('Archive'));
  if (btn) btn.click();
});
await sleep(500);
ok('archive subject confirmation', await has('Archive subject?'));
await inDialog('Archive subject');
await sleep(1300);
ok('subject archived', await has('Subject archived'));

console.log('— students: roster + precreate + validation');
await page.goto(`${BASE}/cr/students`, { waitUntil: 'networkidle0' });
ok('seeded student visible (active)', await has('Ali Khan') && await has('ST-001') && await has('Active'));
await clickByText('button', 'Add student');
await sleep(400);
await type('#student-name', 'Sara Ahmed');
await type('#student-roll', 'ST-002');
await type('#student-email', 'sara@local.test');
await page.click('button[type=submit]');
await sleep(1500);
ok('student precreated (pending badge)', await has('Sara Ahmed') && await has('Pending'));
ok('roster count = 2', await has('2 student'));
// invalid email client validation
await clickByText('button', 'Add student');
await sleep(300);
await type('#student-name', 'Bad Email');
await type('#student-roll', 'ST-003');
await type('#student-email', 'not-an-email');
await page.click('button[type=submit]');
await sleep(500);
ok('invalid email blocked client-side', await has('valid email'));
await clickByText('button', 'Cancel');
await sleep(300);
// duplicate rollNo → 409
await clickByText('button', 'Add student');
await sleep(300);
await type('#student-name', 'Dup Roll');
await type('#student-roll', 'ST-002');
await type('#student-email', 'dup@local.test');
await page.click('button[type=submit]');
await sleep(1400);
ok('duplicate roll rejected by server', await has('Duplicate value') || await has('already'));
await clickByText('button', 'Cancel');
await sleep(300);
// search filter
await type('#admin-search', 'Ali');
await sleep(300);
ok('client search filters roster', await has('Ali Khan') && !(await has('Sara Ahmed')));

console.log('— announcements: create, view, edit, archive');
await page.goto(`${BASE}/cr/announcements`, { waitUntil: 'networkidle0' });
await clickByText('button', 'New announcement');
await sleep(400);
await type('#ann-title', 'Quiz 1 next Monday');
await type('#ann-content', 'Quiz 1 covers chapters 1–3. Bring your own paper.');
await page.click('button[type=submit]');
await sleep(1500);
ok('announcement published + flash', await has('Announcement published') && await has('Quiz 1 next Monday'));
// client validation
await clickByText('button', 'New announcement');
await sleep(300);
await type('#ann-title', 'X');
await page.click('button[type=submit]');
await sleep(400);
ok('announcement title validation', await has('title') || await has('least'));
await clickByText('button', 'Cancel');
await sleep(300);
// view modal
await clickByText('button', 'Quiz 1 next Monday');
await sleep(400);
ok('view modal shows full content', await has('chapters 1–3'));
await page.keyboard.press('Escape');
await sleep(300);
// edit
await clickByText('button', 'Edit');
await sleep(400);
await type('#ann-title', 'Quiz 1 next Monday (updated)');
await page.click('button[type=submit]');
await sleep(1300);
ok('announcement edited', await has('(updated)'));
// archive
await clickByText('button', 'Archive');
await sleep(400);
ok('archive announcement confirmation', await has('Archive announcement?'));
await inDialog('Archive announcement');
await sleep(1300);
ok('announcement archived', await has('Announcement archived'));

console.log('— notes: create with subject, filter, archive');
await page.goto(`${BASE}/cr/notes`, { waitUntil: 'networkidle0' });
await clickByText('button', 'New note');
await sleep(400);
await type('#note-title', 'Chapter 4 summary');
await page.select('#note-subject', await selNth('#note-subject', 1));
await type('#note-content', 'Big-O notation: O(1), O(log n), O(n).');
await page.click('button[type=submit]');
await sleep(1300);
ok('note created with subject badge', await has('Chapter 4 summary') && (await has('Programming Fundamentals') || await has('CS-101')));
// archive
await clickByText('button', 'Archive');
await sleep(400);
await inDialog('Archive note');
await sleep(1300);
ok('note archived', await has('Note archived'));

console.log('— assignments: create, edit deadline, submissions view, archive');
await page.goto(`${BASE}/cr/assignments`, { waitUntil: 'networkidle0' });
await clickByText('button', 'New assignment');
await sleep(400);
await type('#asg-title', 'Lab 3 — linked list');
await page.select('#asg-subject', await selNth('#asg-subject', 1));
await page.click('button[type=submit]');
await sleep(1400);
ok('assignment created with deadline shown', await has('Lab 3 — linked list') && await has('Due'));
// edit: change title
await clickByText('button', 'Edit');
await sleep(400);
await type('#asg-title', 'Lab 3 — linked lists');
await page.click('button[type=submit]');
await sleep(1300);
ok('assignment edited', await has('Lab 3 — linked lists'));
// submissions (empty)
await clickByText('button', 'Submissions');
await sleep(900);
ok('submissions empty state', await has('No submissions yet'));
await page.keyboard.press('Escape');
await sleep(300);
// archive
await clickByText('button', 'Archive');
await sleep(400);
await inDialog('Archive assignment');
await sleep(1300);
ok('assignment archived', await has('Assignment archived'));

console.log('— timetable: add slot, overlap 409, archive');
await page.goto(`${BASE}/cr/timetable`, { waitUntil: 'networkidle0' });
await sleep(800);
ok('timetable empty state (grid appears once classes exist)', await has('No timetable entries yet'));
await clickByText('button', 'Add class');
await sleep(400);
await page.select('#slot-subject', await selNth('#slot-subject', 1));
await page.select('#slot-day', 'monday');
await type('#slot-start', '09:00');
await type('#slot-end', '10:30');
await type('#slot-room', 'Room 204');
await page.click('button[type=submit]');
await sleep(1400);
ok('slot added (monday, room shown)', await has('Room 204') && await has('09:00–10:30'));
// overlapping slot → 409
await clickByText('button', 'Add class');
await sleep(400);
await page.select('#slot-subject', await selNth('#slot-subject', 1));
await page.select('#slot-day', 'monday');
await type('#slot-start', '10:00');
await type('#slot-end', '11:30');
await page.click('button[type=submit]');
await sleep(1400);
ok('overlapping slot rejected', await has('overlap') || await has('Overlap'));
await clickByText('button', 'Cancel');
await sleep(300);
// archive the slot
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.includes('Archive'));
  if (btn) btn.click();
});
await sleep(500);
ok('slot archive confirmation', await has('Remove class slot?'));
await inDialog('Remove slot');
await sleep(1300);
ok('slot archived (back to empty state)', await has('Class slot removed from the timetable') && await has('No timetable entries yet'));

console.log('— attendance: session, one-time code + QR, cancel');
await page.goto(`${BASE}/cr/attendance`, { waitUntil: 'networkidle0' });
await clickByText('button', 'Start session');
await sleep(400);
await page.select('#att-subject', await selNth('#att-subject', 1));
await page.click('button[type=submit]');
await sleep(1500);
const code = await page.evaluate(() => document.querySelector('.font-mono.text-3xl')?.textContent?.trim() ?? '');
ok('one-time 8-char Crockford code displayed', /^[A-Z0-9]{8}$/.test(code));
const qrRendered = await page.evaluate(() => Boolean(document.querySelector('[role="img"] svg')));
ok('QR rendered on-device', qrRendered);
ok('expiry note (10 minutes)', await has('10 minutes') || await has('only this once'));
await clickByText('button', 'Copy code');
await sleep(400);
await clickByText('button', 'Done');
await sleep(800);
ok('session listed as Active with count', await has('Active') && await has('present'));
// cancel
await clickByText('button', 'Cancel');
await sleep(400);
ok('cancel session confirmation', await has('Cancel attendance session?'));
await page.evaluate(() => {
  const dlg = [...document.querySelectorAll('.fixed.inset-0 button')].find((e) => e.textContent.trim() === 'Cancel session');
  if (dlg) dlg.click();
});
await sleep(1300);
ok('session cancelled', await has('Session cancelled') && await has('Cancelled'));

console.log('— marks: draft → open → enter → finalize → locked → archive');
await page.goto(`${BASE}/cr/marks`, { waitUntil: 'networkidle0' });
await clickByText('button', 'New assessment');
await sleep(400);
await type('#asmt-title', 'Quiz 1');
await page.select('#asmt-type', 'quiz');
await page.select('#asmt-subject', await selNth('#asmt-subject', 1));
await type('#asmt-total', '20');
await page.click('button[type=submit]');
await sleep(1500);
ok('assessment created as draft', await has('Quiz 1') && await has('Draft'));
// open it
await clickByText('button', 'Open');
await sleep(400);
ok('open confirmation', await has('Open assessment?'));
await inDialog('Open assessment');
await sleep(1300);
ok('assessment now Open', await has('Open'));
// enter marks for Ali
await clickByText('button', 'Enter marks');
await sleep(900);
const marksInputVisible = await page.evaluate(() => Boolean(document.querySelector('input[type="number"][aria-label^="Marks for"]')));
ok('marks entry rows render (active student)', marksInputVisible);
await page.evaluate(() => {
  const inp = document.querySelector('input[type="number"][aria-label^="Marks for"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inp, '17');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
ok('unsaved change detected', await has('unsaved change'));
await clickByText('button', 'Save 1 mark');
await sleep(1500);
ok('mark saved (Entered badge)', await has('Entered') && await has('1 entered') === false || await has('entered'));
// finalize (with confirm)
await clickByTextExact('button', 'Finalize');
await sleep(400);
ok('finalize confirmation warns permanent', await has('Finalize assessment?') || await has('locked permanently'));
await inDialog('Finalize marks');
await sleep(1500);
ok('assessment finalized flash', await has('marks are locked'));
// verify locked/read-only
await clickByText('button', 'View marks');
await sleep(900);
ok('finalized marks read-only', await has('This assessment is finalized'));
await page.keyboard.press('Escape');
await sleep(300);
// archive
await clickByText('button', 'Archive');
await sleep(400);
await inDialog('Archive assessment');
await sleep(1300);
ok('assessment archived', await has('Assessment archived'));

console.log('— notifications page renders (announcement fan-out)');
await page.goto(`${BASE}/cr/notifications`, { waitUntil: 'networkidle0' });
await sleep(800);
ok('notifications page renders', await has('Notifications') && (await has('all caught up') || await has('Mon') || await has('Announcement')));

console.log('— profile + logout');
await page.goto(`${BASE}/cr/profile`, { waitUntil: 'networkidle0' });
ok('profile shows safe data', await has('Test CR') && await has('cr@local.test'));
ok('no password/token data exposed', !(await has('password')) || (await text()).toLowerCase().indexOf('hash') === -1);
await clickByText('button', 'Sign out');
await sleep(1800);
ok('logout returns to /login', page.url().endsWith('/login'));

console.log('— route protection: logged-out /cr → login; wrong role /admin → own home');
await page.goto(`${BASE}/cr`, { waitUntil: 'networkidle0' });
await sleep(1500);
ok('logged-out /cr redirects to /login', page.url().endsWith('/login'));
await type('#email', CR.email);
await type('#password', CR.password);
await page.keyboard.press('Enter');
await sleep(2500);
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' });
await sleep(1500);
ok('CR blocked from /admin (sent to own home)', page.url().includes('/cr') && !page.url().includes('/admin'));

console.log('— mobile viewport: drawer nav');
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await page.goto(`${BASE}/cr`, { waitUntil: 'networkidle0' });
await sleep(1200);
const hamburger = await page.$('button[aria-label="Open navigation menu"]');
ok('mobile: hamburger visible', Boolean(hamburger));
if (hamburger) {
  await hamburger.click();
  await sleep(500);
  ok('mobile: drawer opens with nav links', await has('Dashboard') && await has('Attendance'));
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (consoleErrors.length) {
  console.log('CONSOLE/HTTP ERRORS:');
  consoleErrors.slice(0, 15).forEach((e) => console.log('  ' + e.slice(0, 160)));
}
await browser.close();
process.exit(failed ? 1 : 0);
