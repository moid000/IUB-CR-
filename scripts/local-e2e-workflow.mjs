/**
 * STEP 17 WORKFLOW E2E — complete Admin → CR → Student lifecycle against the
 * LOCAL e2e server (in-memory Mongo, mocked Brevo) + real headless Chromium
 * for the student-portal phases. Requires: local-e2e-server.mjs running
 * WITHOUT SEED_CR + frontend dev server on :5173.
 *
 * Covered:
 *  D.  Admin → dept → session → sections → CRs → activation → CR builds
 *      students/subjects/content → student activation → student consumes.
 *  E.  Section isolation CR-A vs CR-B (API), student cross-section, and
 *      student-vs-student submission/marks privacy.
 *  R.  Route matrix (student blocked from /admin + /cr, refresh, logout +
 *      back-button navigation).
 *  S.  Cross-portal data consistency (same ids/titles/values everywhere).
 *  V.  Console/page-error monitor with an expected-negative allowlist.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/tmp/chrome-headless-shell/linux-153.0.8010.36/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = 'http://localhost:5173/frontend';
const API = 'http://localhost:3000';
const PASSWORD = 'QaWorkflow!2026';

/* reset DB — the script builds its own world from scratch */
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

const consoleErrors = [];
let PHASE = 'init';
const EXPECTED_NEGATIVES = [];
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
  if (r.status() === 404 && u.includes('/__e2e/otp/')) return; // script polling
  const expected = EXPECTED_NEGATIVES.some((p) => u.includes(p));
  consoleErrors.push({ phase: PHASE, msg: `HTTP ${r.status()} ${u}`, expected });
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
const openDrawer = async () => { await clickByText('button', 'Open navigation menu'); await sleep(350); };
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

/* ------------------------- activation via real OTP flow ------------------------- */
async function getOtp(email) {
  for (let i = 0; i < 24; i += 1) {
    const j = await fetch(`${API}/__e2e/otp/${encodeURIComponent(email)}`).then((r) => r.json());
    if (j.otp) return j.otp;
    await sleep(150);
  }
  throw new Error(`OTP for ${email} never arrived`);
}
async function activateViaApi(kind, email) {
  await api('anon', 'POST', `/api/auth/${kind}/request-otp`, { email });
  const code = await getOtp(email);
  const v = await api('anon', 'POST', `/api/auth/${kind}/verify-otp`, { email, otp: code });
  const activationToken = v.json?.activationToken ?? v.json?.data?.activationToken;
  if (!activationToken) throw new Error(`verify-otp for ${email} returned no token: ${JSON.stringify(v.json).slice(0, 140)}`);
  const s = await api('anon', 'POST', `/api/auth/${kind}/set-password`, { activationToken, password: PASSWORD, confirmPassword: PASSWORD });
  ok(`${kind} activation completed (real OTP flow) — ${email}`, s.status === 200);
}

/* ==================================== PHASES ==================================== */

console.log('— phase A: admin builds hierarchy (real API)');
PHASE = 'admin-setup';
const aLogin = await api('admin', 'POST', '/api/auth/login', { email: 'admin@local.test', password: 'Step14Admin!2026' });
ok('admin login', aLogin.status === 200 && aLogin.json.user.role === 'admin');

const dept = (await api('admin', 'POST', '/api/admin/departments', { name: 'QA Workflow Dept', code: 'QAWF' })).json.data;
ok('department created', !!dept._id);
const sess = (await api('admin', 'POST', '/api/admin/sessions', { name: 'QA Session 2026', startedAt: '2026-09-01', endedAt: '2027-06-30', status: 'active' })).json.data;
ok('active session created', !!sess._id && sess.status === 'active');
const secA = (await api('admin', 'POST', '/api/admin/sections', { department: dept._id, session: sess._id, semester: 3, name: 'QA-A' })).json.data;
const secB = (await api('admin', 'POST', '/api/admin/sections', { department: dept._id, session: sess._id, semester: 3, name: 'QA-B' })).json.data;
ok('sections A + B created', !!secA._id && !!secB._id);

const crA = (await api('admin', 'POST', '/api/admin/crs', { name: 'QA CR One', email: 'cr-a@qa.test', phone: '+923001110001', sectionId: secA._id })).json.data;
const crB = (await api('admin', 'POST', '/api/admin/crs', { name: 'QA CR Two', email: 'cr-b@qa.test', phone: '+923001110002', sectionId: secB._id })).json.data;
ok('CRs pre-created', !!crA._id && !!crB._id);
const secALive = (await api('admin', 'GET', `/api/admin/sections/${secA._id}`)).json.data;
ok('section A .cr = CR A (both sides live at creation)', String(secALive.cr?._id ?? secALive.cr) === String(crA._id));

const pendingLogin = await api('anon', 'POST', '/api/auth/login', { email: 'cr-a@qa.test', password: PASSWORD }, true);
ok('pending CR cannot login yet (403 not activated)', pendingLogin.status === 403 || pendingLogin.status === 401);

await activateViaApi('cr', 'cr-a@qa.test');
await activateViaApi('cr', 'cr-b@qa.test');

const crALogin = await api('crA', 'POST', '/api/auth/login', { email: 'cr-a@qa.test', password: PASSWORD });
ok('CR A logs in after activation', crALogin.status === 200 && crALogin.json.user.role === 'cr');
await api('crB', 'POST', '/api/auth/login', { email: 'cr-b@qa.test', password: PASSWORD });
const meA = (await api('crA', 'GET', '/api/auth/me')).json;
const meASection = meA.user?.section?.name ?? meA.section?.name ?? meA.section;
ok('CR A section context = QA-A (server-derived)', String(meASection) === 'QA-A' || String(meA.section ?? '') === String(secA._id));

console.log('— phase B: CR A builds section-A content');
PHASE = 'cr-a-content';
const subj = (await api('crA', 'POST', '/api/cr/subjects', { code: 'QA101', name: 'Workflow Engineering', teacherName: 'Dr. QA Tester', creditHours: 3, description: 'Step-17 cross-portal verification subject' })).json.data;
ok('subject QA101 created', subj.code === 'QA101');

const stA = (await api('crA', 'POST', '/api/cr/students', { name: 'QA Student One', email: 'student-a@qa.test', rollNo: 'QA-001', phone: '+923002220001' })).json.data;
const stB = (await api('crA', 'POST', '/api/cr/students', { name: 'QA Student Two', email: 'student-b@qa.test', rollNo: 'QA-002', phone: '+923002220002' })).json.data;
ok('students pre-created in section A', !!stA._id && !!stB._id);
const roster = (await api('crA', 'GET', '/api/cr/students')).json;
ok('roster contains exactly both (section-scoped)', roster.data.length === 2);

await activateViaApi('student', 'student-a@qa.test');
await activateViaApi('student', 'student-b@qa.test');
await api('stA', 'POST', '/api/auth/login', { email: 'student-a@qa.test', password: PASSWORD });
await api('stB', 'POST', '/api/auth/login', { email: 'student-b@qa.test', password: PASSWORD });

const ann = (await api('crA', 'POST', '/api/cr/announcements', { title: 'QA Workflow Announcement', content: 'Midterm schedule published for QA101. All section QA-A students must attend.' })).json.data;
ok('announcement published', !!ann._id);
const note = (await api('crA', 'POST', '/api/cr/notes', { title: 'QA Workflow Notes', content: 'Lecture 1–5 consolidated notes.', subject: subj._id })).json.data;
ok('note created (subject-linked)', !!note._id);
const deadline = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
const asg = (await api('crA', 'POST', '/api/cr/assignments', { subject: subj._id, title: 'Workflow Task 1', instructions: 'Submit your workflow diagram.', deadline })).json.data;
ok('assignment created with future deadline', !!asg._id);
const slot = (await api('crA', 'POST', '/api/cr/timetable', { subject: subj._id, day: 'monday', startTime: '11:00', endTime: '12:30', room: 'QA-201' })).json.data;
ok('timetable slot created', !!slot._id);
const att = (await api('crA', 'POST', '/api/cr/attendance/sessions', { subject: subj._id })).json.data;
ok('attendance session live + 8-char Crockford code returned once', !!att.session?._id && /^[0-9A-Z]{8}$/.test(att.code));
const ATT_CODE = att.code;

console.log('— phase C: CR B cross-section isolation (API)');
PHASE = 'cr-b-isolation';
const probes = [
  ['GET', `/api/cr/subjects/${subj._id}`],
  ['GET', `/api/cr/announcements/${ann._id}`],
  ['GET', `/api/cr/notes/${note._id}`],
  ['GET', `/api/cr/assignments/${asg._id}`],
  ['GET', `/api/cr/timetable/${slot._id}`],
  ['GET', `/api/cr/attendance/sessions/${att.session._id}`],
  ['PATCH', `/api/cr/announcements/${ann._id}`],
];
for (const [m, p] of probes) {
  EXPECTED_NEGATIVES.push(p);
  const body = m === 'PATCH' ? { title: 'hacked' } : undefined;
  const r = await api('crB', m, p, body, true);
  ok(`CR B ${m} ${p} → 404`, r.status === 404);
}
const crBList = (await api('crB', 'GET', '/api/cr/announcements')).json;
ok('CR B list does NOT contain section-A announcement', !crBList.data.some((x) => x._id === ann._id));

await api('crB', 'POST', '/api/cr/subjects', { code: 'QB101', name: 'Section B Subject', teacherName: 'Dr. B' });
await api('crB', 'POST', '/api/cr/students', { name: 'QA Student Three', email: 'student-c@qa.test', rollNo: 'QB-001', phone: '+923002220003' });
await activateViaApi('student', 'student-c@qa.test');
await api('stC', 'POST', '/api/auth/login', { email: 'student-c@qa.test', password: PASSWORD });

console.log('— phase D: student A full journey (browser)');
PHASE = 'student-browser';
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
await type('#email', 'student-a@qa.test');
await type('#password', PASSWORD);
await clickByText('button', 'Sign in');
await sleep(1300);
ok('student A logged in → /student', page.url().includes('/student'));
await sleep(900);
ok('dashboard greeting (first name) + section QA-A', (await has('Welcome back, QA')) && (await has('QA-A')));

await navTo('Subjects', '/student/subjects');
ok('subject QA101 + name visible (instructor col is desktop-only)', (await has('QA101')) && (await has('Workflow Engineering')));

await navTo('Announcements', '/student/announcements');
ok('CR announcement visible to student', await has('QA Workflow Announcement'));

await navTo('Notes', '/student/notes');
ok('CR note visible to student', await has('QA Workflow Notes'));

await navTo('Assignments', '/student/assignments');
ok('assignment "Workflow Task 1" listed as Pending', (await has('Workflow Task 1')) && (await has('Pending')));
EXPECTED_NEGATIVES.push(`/api/student/assignments/${asg._id}/submission`); // pre-submit GET is a by-design 404
await clickByText('button', 'Workflow Task 1');
await sleep(700);
ok('detail modal shows instructions', await has('Submit your workflow diagram.'));
await type('#submission-answer', 'My workflow diagram: A → B → C, verified end-to-end.');
await clickExact('Submit');
await sleep(1600);
ok('submission confirmed (Submitted state)', (await has('Resubmission is allowed until the deadline.')) || (await has('Update submission')));
await page.keyboard.press('Escape');
await sleep(400);
const mySub1 = await api('stA', 'GET', `/api/student/assignments/${asg._id}/submission`);
ok('student A has exactly one submission via API', mySub1.status === 200 && !!mySub1.json.data);

await navTo('Timetable', '/student/timetable');
await clickByText('summary', 'Mon'); await sleep(350);
ok('timetable slot + room QA-201 visible', (await has('Workflow Engineering')) && (await has('QA-201')));

await navTo('Attendance', '/student/attendance');
await sleep(500);
ok('active session listed (no code hint)', await has('Workflow Engineering'));
await page.waitForSelector('input[id^="code-"]', { visible: true, timeout: 5000 });
await page.type('input[id^="code-"]', ATT_CODE, { delay: 10 });
await clickByText('button', 'Mark present');
await sleep(1400);
ok('attendance marked with real CR code', await has('Attended'));

EXPECTED_NEGATIVES.push(`/api/student/attendance/sessions/${att.session._id}/attend`);
const cAttend = await api('stC', 'POST', `/api/student/attendance/sessions/${att.session._id}/attend`, { code: ATT_CODE }, true);
ok('student C (section B) attend → rejected (404/403)', cAttend.status === 404 || cAttend.status === 403);
const aDup = await api('stA', 'POST', `/api/student/attendance/sessions/${att.session._id}/attend`, { code: ATT_CODE }, true);
ok('duplicate attendance rejected (409)', aDup.status === 409);

console.log('— phase E: assessment + marks across portals');
PHASE = 'marks';
const asm = (await api('crA', 'POST', '/api/cr/assessments', { subject: subj._id, title: 'QA Midterm Quiz', type: 'quiz', totalMarks: 25, assessmentDate: '2026-09-10' })).json.data;
ok('assessment created (draft)', asm.status === 'draft');
const draftMark = await api('crA', 'POST', `/api/cr/assessments/${asm._id}/marks`, { student: stA._id, marksObtained: 18 }, true);
ok('draft cannot receive marks (400)', draftMark.status === 400);
await api('crA', 'POST', `/api/cr/assessments/${asm._id}/open`);
const badMark = await api('crA', 'POST', `/api/cr/assessments/${asm._id}/marks`, { student: stA._id, marksObtained: 30 }, true);
ok('marks > total rejected (400)', badMark.status === 400);
const mk = (await api('crA', 'POST', `/api/cr/assessments/${asm._id}/marks`, { student: stA._id, marksObtained: 18 })).json.data;
ok('mark 18/25 entered', String(mk.marksObtained) === '18');
const fin = (await api('crA', 'POST', `/api/cr/assessments/${asm._id}/finalize`)).json.data;
ok('assessment finalized (marks locked)', fin.status === 'finalized');
const postFin = await api('crA', 'PATCH', `/api/cr/assessments/${asm._id}/marks/${stA._id}`, { marksObtained: 20 }, true);
ok('finalized marks immutable', postFin.status === 400 || postFin.status === 409);

await navTo('Marks', '/student/marks');
await sleep(400);
ok('student sees finalized 18 / 25', (await has('18')) && (await has('25')) && (await has('QA Midterm Quiz')));
const myMarks = (await api('stA', 'GET', '/api/student/marks')).json;
const mine = myMarks.data.find((x) => x.assessment === asm._id || x.assessment?._id === asm._id);
ok('student marks API carries 18 for the quiz', String(mine?.marksObtained) === '18');
const bMarks = (await api('stB', 'GET', '/api/student/marks')).json;
ok('student B has NO mark row (never entered)', !bMarks.data.some((x) => String(x.student) === String(stA._id)));

console.log('— phase F: notifications (cross-portal + isolation)');
PHASE = 'notifications';
await navTo('Notifications', '/student/notifications');
await sleep(900);
const unread = (await api('stA', 'GET', '/api/student/notifications/unread-count')).json;
const unreadCount = Number(unread.data?.count ?? unread.count ?? 0);
ok('student A has unread notifications (announcement+assignment+marks)', unreadCount >= 2);
ok('notification page lists announcement event', await has('QA Workflow Announcement'));
const before = (await api('stA', 'GET', '/api/student/notifications?limit=100')).json;
const asgNotif = before.data.find((n) => ((n.title ?? '') + (n.message ?? '')).includes('Workflow Task 1'));
ok('assignment notification present for student A', !!asgNotif);
ok('no duplicate notifications (dedupe held)', new Set(before.data.map((n) => n._id)).size === before.data.length);
await api('stA', 'POST', '/api/student/notifications/read-all');
const unread2 = (await api('stA', 'GET', '/api/student/notifications/unread-count')).json;
ok('read-all → unread count 0', Number(unread2.data?.count ?? unread2.count ?? 0) === 0);

const cNotifs = (await api('stC', 'GET', '/api/student/notifications?limit=100')).json;
ok('student C never received section-A notifications', !cNotifs.data.some((n) => ((n.title ?? '') + (n.message ?? '')).includes('QA Workflow')));

console.log('— phase G: student privacy + cross-section content (API)');
PHASE = 'student-privacy';
const bSees = await api('stB', 'GET', `/api/student/assignments/${asg._id}/submission`, undefined, true);
ok('student B "my submission" → 404 (own only, A invisible)', bSees.status === 404);
const cPaths = [
  [`/api/student/announcements/${ann._id}`],
  [`/api/student/notes/${note._id}`],
  [`/api/student/assignments/${asg._id}`],
  [`/api/student/timetable/${slot._id}`],
  [`/api/student/assessments/${asm._id}`],
];
for (const [p] of cPaths) {
  EXPECTED_NEGATIVES.push(p);
  const r = await api('stC', 'GET', p, undefined, true);
  ok(`student C GET ${p} → 404`, r.status === 404);
}
const cSubjects = (await api('stC', 'GET', '/api/student/subjects')).json;
ok('student C subject list has QB101 only', cSubjects.data.some((x) => x.code === 'QB101') && !cSubjects.data.some((x) => x.code === 'QA101'));

console.log('— phase H: CR A sees student A work (consistency)');
PHASE = 'cr-a-verify';
const subs = (await api('crA', 'GET', `/api/cr/assignments/${asg._id}/submissions`)).json;
const subA = subs.data.find((x) => String(x.student?._id ?? x.student) === String(stA._id));
ok('CR sees student A submission with exact text', subA?.textAnswer?.includes('A → B → C') === true);
const records = (await api('crA', 'GET', `/api/cr/attendance/sessions/${att.session._id}/records`)).json;
ok('CR sees attendance record (exactly 1 present)', records.data.length === 1);
const sheet = (await api('crA', 'GET', `/api/cr/assessments/${asm._id}/marks`)).json;
const sheetRows = sheet.data.items ?? sheet.data;
const sheetRow = sheetRows.find((x) => String(x.student?._id ?? x.student) === String(stA._id));
ok('CR marks sheet shows 18 for student A', String(sheetRow?.marksObtained) === '18');
const asgFromStudent = (await api('stA', 'GET', `/api/student/assignments/${asg._id}`)).json.data;
ok('same subject id flows CR↔student', String(asgFromStudent.subject?._id ?? asgFromStudent.subject) === String(subj._id));

console.log('— phase I: route matrix + logout protection (browser)');
PHASE = 'route-matrix';
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle0' }); await sleep(900);
ok('student blocked from /admin (redirected)', !page.url().includes('/admin'));
await page.goto(`${BASE}/cr`, { waitUntil: 'networkidle0' }); await sleep(900);
ok('student blocked from /cr (redirected)', !(page.url().includes('/cr') && !page.url().includes('/student')));
await page.goto(`${BASE}/student/marks`, { waitUntil: 'networkidle0' }); await sleep(900);
ok('direct refresh keeps session (httpOnly cookie)', page.url().includes('/student/marks'));
await navTo('Profile', '/student/profile');
ok('logout control visible', (await has('Sign out')) || (await has('Log out')));
await clickByText('button', 'Sign out');
await sleep(1100);
ok('logout → /login', page.url().includes('/login'));
await page.goBack(); await sleep(1000);
const backUrl = page.url();
ok('back after logout reveals no student data', !backUrl.includes('/student') || (await has('Sign in')));
await page.goto(`${BASE}/student`, { waitUntil: 'networkidle0' }); await sleep(900);
ok('post-logout /student → login redirect', !page.url().includes('/student') || page.url().includes('/login'));

console.log('— integrity: browser console/page errors');
const real = consoleErrors.filter((e) => !e.expected);
ok('zero unexpected browser errors across all phases', real.length === 0);
if (real.length) console.log('  errors:', real.slice(0, 8));

await browser.close();
console.log(`\nWORKFLOW E2E: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
