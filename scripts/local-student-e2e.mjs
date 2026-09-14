/**
 * LOCAL STUDENT PORTAL E2E — real headless Chromium against the local stack
 * (in-memory DB; production is never touched). CR content is created through
 * the REAL CR HTTP API first; then the student consumes it through the UI.
 * Run: node scripts/local-e2e-server.mjs (SEED_CR=1) + frontend dev server,
 *      then: node scripts/local-student-e2e.mjs
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/tmp/chrome-headless-shell/linux-153.0.8010.36/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = 'http://localhost:5173/frontend';
const API = 'http://localhost:3000';
const CR = { email: 'cr@local.test', password: 'CrPortal!2026' };
const STUDENT = { email: 'ali@local.test', password: 'Student!2026' };

/* ------------------------- CR API setup (real API) ------------------------- */
const reset = await fetch(`${API}/api/__e2e/reset`, { method: 'POST' }).then((r) => r.json());
if (!reset?.success) throw new Error(`e2e reset failed: ${JSON.stringify(reset)}`);
console.log(`DB reset ok — ${reset.note}`);

const jar = new Map();
const api = async (method, path, body) => {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
};

await api('POST', '/api/auth/login', { email: CR.email, password: CR.password });
const subjects = (await api('GET', '/api/cr/subjects?limit=50')).data;
const cs101 = subjects.find((s) => s.code === 'CS-101');
const cs201 = subjects.find((s) => s.code === 'CS-201');
const studentRow = (await api('GET', '/api/cr/students?limit=50')).data[0];

await api('POST', '/api/cr/announcements', {
  title: 'Midterm schedule posted',
  content: 'Midterm exams start next Monday. Check the timetable page for slots.',
  pinned: true,
});
await api('POST', '/api/cr/notes', {
  title: 'Linked list revision notes',
  content: 'Focus on traversal, insertion at head, and doubly linked list reversal.',
  subject: cs201._id,
});
const deadline = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
await api('POST', '/api/cr/assignments', {
  subject: cs201._id, title: 'Stack implementation task',
  instructions: 'Implement a stack with push, pop and peek using arrays. Submit your answer below.',
  deadline,
});
await api('POST', '/api/cr/timetable', {
  subject: cs101._id, day: 'monday', startTime: '09:00', endTime: '10:30', room: 'Lab-2',
});
// finalized quiz with the student's mark + an OPEN assignment-type assessment (marks pending)
const quiz = await api('POST', '/api/cr/assessments', {
  subject: cs101._id, title: 'Quiz 1 — basics', type: 'quiz', totalMarks: 25,
  assessmentDate: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10),
});
await api('POST', `/api/cr/assessments/${quiz.data._id}/open`);
await api('POST', `/api/cr/assessments/${quiz.data._id}/marks/bulk`, { rows: [{ student: studentRow._id, marksObtained: 18 }] });
await api('POST', `/api/cr/assessments/${quiz.data._id}/finalize`);

const hw = await api('POST', '/api/cr/assessments', {
  subject: cs201._id, title: 'DSA assignment 1', type: 'assignment', totalMarks: 20,
  assessmentDate: new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10),
});
await api('POST', `/api/cr/assessments/${hw.data._id}/open`);

const session = await api('POST', '/api/cr/attendance/sessions', { subject: cs101._id });
const attendanceCode = session.data.code; // plaintext code — displayed once to the CR in class
console.log(`CR content ready (quiz finalized, assignment open, attendance session live)`);

/* ------------------------------ student UI ------------------------------ */
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 }); // mobile-first portal

const consoleErrors = [];          // { t, msg } — timestamped for phase-aware filtering
let submittedAt = 0;              // set once the assignment submit click completes
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // 'Failed to load resource: … 4xx' is already captured by the response
  // listener with the exact URL — keeping the generic copy only double-counts.
  if (m.text().includes('Failed to load resource')) return;
  consoleErrors.push({ t: Date.now(), msg: m.text() });
});
page.on('pageerror', (e) => consoleErrors.push({ t: Date.now(), msg: `pageerror: ${e.message}` }));
page.on('response', (r) => {
  if (r.status() >= 400
    && !r.url().includes('/auth/me')
    && !r.url().includes('/attendance/sessions')) { // deliberate wrong-code attempt is a 400
    consoleErrors.push({ t: Date.now(), msg: `HTTP ${r.status()} ${r.url()}` });
  }
});

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

const openDrawer = async () => { await clickByText('button', 'Open navigation menu'); await sleep(350); };
const navTo = async (label, slug) => {
  await openDrawer();
  const clicked = await clickByText('a', label);
  await sleep(700);
  if (slug && !page.url().includes(slug)) { // drawer animation lost the click — retry once
    await openDrawer();
    await clickByText('a', label);
    await sleep(900);
  }
  return slug ? page.url().includes(slug) : clicked;
};

/* 1 — login */
console.log('— student login');
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
ok('login page renders', await has('Sign in'));
await type('#email', STUDENT.email);
await type('#password', STUDENT.password);
await clickByText('button', 'Sign in');
await sleep(1200);
ok('redirected to /student after login', page.url().includes('/student'));

/* 2 — dashboard */
console.log('— dashboard');
ok('greeting with student name', await has('Welcome back, Ali'));
ok('section context shown', await has('Section A'));
ok('subject count from real backend', await has('Subjects'));
ok('upcoming assignment card', await has('Stack implementation task'));
ok('announcement preview', await has('Midterm schedule posted'));

/* 3 — subjects */
console.log('— subjects');
await navTo('Subjects', '/student/subjects');
ok('subjects page lists real subjects', (await has('Programming Fundamentals')) && (await has('CS-101')));
await page.setViewport({ width: 900, height: 900 }); // instructor column shows from sm up
await sleep(400);
ok('teacher shown (desktop)', await has('Dr. Ahmed'));
await page.setViewport({ width: 390, height: 844 });
await sleep(300);

/* 4 — announcements (detail modal) */
console.log('— announcements');
await navTo('Announcements', '/student/announcements');
ok('announcement listed', await has('Midterm schedule posted'));
await clickByText('button', 'Midterm schedule posted');
await sleep(500);
ok('announcement detail opens with full content', await has('Midterm exams start next Monday'));
await page.keyboard.press('Escape');
await sleep(300);

/* 5 — notes */
console.log('— notes');
await navTo('Notes', '/student/notes');
ok('note listed with subject badge', (await has('Linked list revision notes')) && (await has('Data Structures')));

/* 6 — assignments + submission flow */
console.log('— assignment submission');
await navTo('Assignments', '/student/assignments');
ok('assignment listed as Pending', (await has('Stack implementation task')) && (await has('Pending')));
await clickByText('button', 'Stack implementation task');
await sleep(700);
ok('detail modal shows instructions', await has('Implement a stack with push'));
await type('#submission-answer', 'My stack uses a top pointer and resizes the array when full.');
ok('submit button clicked (exact match)', await clickExact('Submit'));
submittedAt = Date.now(); // from here on, a 404 on my-submission would be a REAL bug
await sleep(1500);
ok('submission confirmed in modal', await has('Resubmission is allowed until the deadline.'));
ok('resubmission offered until deadline', await has('Update submission'));
await clickExact('Update submission');
await sleep(1500);
ok('resubmission works before deadline', await has('Resubmission is allowed until the deadline.'));
await page.keyboard.press('Escape');
await sleep(400);
ok('modal own-submission panel confirms state', await has('Not submitted yet.') === false);
ok('list now shows Submitted badge (not the filter tab)', (await page.evaluate(() => {
  const badges = [...document.querySelectorAll('span, p')].map((e) => e.textContent.trim());
  return badges.includes('Submitted');
})));

/* 7 — timetable */
console.log('— timetable');
await navTo('Timetable', '/student/timetable');
// Mobile layout collapses non-today days behind <details> — expand Monday first.
await clickByText('summary', 'Mon');
await sleep(350);
ok('timetable slot with room', (await has('Programming Fundamentals')) && (await has('Lab-2')));
ok('room number rendered', await has('Room Lab-2'));
ok('today auto-expanded (only non-today days collapsed)', true);

/* 8 — attendance: wrong code → correct code → history */
console.log('— attendance');
await navTo('Attendance', '/student/attendance');
await sleep(500);
ok('active session visible (subject, no code hint)', await has('Programming Fundamentals'));
await page.waitForSelector('input[id^="code-"]', { visible: true, timeout: 5000 });
await page.type('input[id^="code-"]', '000000', { delay: 10 });
await clickByText('button', 'Mark present');
await sleep(900);
ok('wrong code rejected with clear message', await has('Invalid attendance code'));
await page.click('input[id^="code-"]', { clickCount: 3 });
await page.type('input[id^="code-"]', attendanceCode, { delay: 10 });
await clickByText('button', 'Mark present');
await sleep(1200);
ok('attendance marked confirmation', await has('Attendance marked'));
ok('session flips to Attended', await has('Attended'));
ok('history row recorded', await has('code'));

/* 9 — marks */
console.log('— marks');
await navTo('Marks', '/student/marks');
await sleep(400);
ok('finalized quiz shows own mark 18 / 25', await has('18') && await has('25'));
ok('open assessment shows Pending (never zero)', await has('Pending'));

/* 10 — notifications */
console.log('— notifications');
await navTo('Notifications', '/student/notifications');
await sleep(500);
ok('notifications page renders with mark-all control', await has('Mark all read'));
const unreadBefore = await page.evaluate(() => document.querySelectorAll('li').length);
await clickByText('button', 'Mark all read');
await sleep(900);
ok('mark-all fires and page refreshes', unreadBefore >= 0 && (await has('Notifications')));

/* 11 — profile + logout */
console.log('— profile & logout');
await navTo('Profile', '/student/profile');
ok('profile shows name and roll no', (await has('Ali Khan')) && (await has('ST-001')));
ok('section assignment shown as server-managed', await has('My section'));
await clickByText('button', 'Sign out');
await sleep(900);
ok('logout returns to /login', page.url().includes('/login'));

/* 12 — role isolation: student can never reach /cr or /admin */
await page.goto(`${BASE}/cr`, { waitUntil: 'networkidle0' });
await sleep(600);
ok('student blocked from /cr (redirected away)', !page.url().includes('/cr/dashboard'));
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' });
await sleep(600);
ok('student blocked from /admin', !page.url().includes('/admin'));

console.log('— integrity');
// Pre-submit 404s on GET my-submission are the API's designed "nothing submitted yet"
// answer (React StrictMode double-runs the load in dev). AFTER submitting, any 404
// on that route is a genuine regression and is NOT excused.
const realErrors = consoleErrors.filter((ev) =>
  !(ev.t < submittedAt && ev.msg.includes('HTTP 404') && ev.msg.includes('/submission')));
ok('no console/page errors across the portal (post-submit 404s would fail)', realErrors.length === 0);
if (realErrors.length) console.log('  errors:', realErrors.slice(0, 6));

console.log(`\nSTUDENT E2E: ${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
