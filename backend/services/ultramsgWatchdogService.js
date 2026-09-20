import { env } from '../config/env.js';
import { WatchdogState } from '../models/index.js';
import { sendWatchdogAlertEmail } from './emailService.js';

/**
 * UltraMsg trial watchdog — keeps the WhatsApp gateway alive 24/7 at ZERO cost.
 *
 * cron-job.org pings GET /api/whatsapp/watchdog?secret=... every hour.
 *   - gateway healthy (authenticated/connected)  → nothing happens
 *   - "Stopped due to non-payment"                → plain-HTTP renewal:
 *       dashboard login (user.ultramsg.com) + the same extend_trial POST the
 *       dashboard button makes. No browser, no paid service.
 *   - needs QR scan / renewal failed               → Brevo email to the owner
 *       (throttled to ~1 email / 20h per kind via the WatchdogState collection)
 *
 * Everything below is verified against the real UltraMsg endpoints:
 *   POST /request/post.php {email,password,signin:'Sign in'} → {"success":"done"}
 *   POST /request/post.php {extend_trial:'138500'}          → {"success":"instance extended..."}
 *   ("signin" submit field is REQUIRED — the server answers {"error":"SESSION error"} without it)
 *
 * Budget: must stay inside the 60s Vercel function limit
 * (status ~1s, renewal ~5s, verify ~25s worst case).
 */

const DASHBOARD = 'https://user.ultramsg.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20_000;
const ALERT_THROTTLE_MS = 20 * 60 * 60 * 1000; // ~1 alert per 20h per kind
const VERIFY_WAIT_MS = Number(process.env.WATCHDOG_VERIFY_WAIT_MS ?? 25_000); // short in tests

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isWatchdogConfigured() {
  return Boolean(
    env.whatsapp.instanceId &&
      env.whatsapp.token &&
      env.whatsapp.dashboardEmail &&
      env.whatsapp.dashboardPassword &&
      env.whatsapp.instanceNumber,
  );
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Raw status text from the UltraMsg API. Returns the JSON if parseable.
 * Stopped instances answer with an error string containing
 * "Stopped due to non-payment"; healthy ones answer
 * {"status":{"accountStatus":{"status":"authenticated","substatus":"connected"}}}
 */
async function fetchInstanceStatus() {
  const url = `${env.whatsapp.apiUrl || 'https://api.ultramsg.com'}/${env.whatsapp.instanceId}/instance/status?token=${env.whatsapp.token}`;
  const res = await fetchWithTimeout(url);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON answer — text is kept */
  }
  return { text, json };
}

function parseHealth({ text, json }) {
  const accountStatus = json?.status?.accountStatus?.status;
  if (accountStatus === 'authenticated' || accountStatus === 'connected') {
    return { healthy: true, status: accountStatus, stopped: false };
  }
  const stopped = /stopped due to non-?payment/i.test(text);
  const needsQr = accountStatus === 'qr';
  return { healthy: false, status: accountStatus || 'unknown', stopped, needsQr };
}

/** Plain-HTTP dashboard login; returns the PHPSESSID cookie value. */
async function dashboardLogin() {
  // 1) seed the session (root redirects to signin and creates the cookie)
  const r1 = await fetchWithTimeout(`${DASHBOARD}/`, {
    headers: { 'user-agent': UA },
    redirect: 'follow',
  });
  const setCookies = r1.headers.getSetCookie?.() ?? [];
  const cookie =
    setCookies.map((c) => c.match(/PHPSESSID=([^;]+)/)?.[1]).find(Boolean) || null;
  if (!cookie) throw new Error('dashboard did not return a session cookie');

  // 2) submit the login form — the "signin" submit field is required
  const r2 = await fetchWithTimeout(`${DASHBOARD}/request/post.php`, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `PHPSESSID=${cookie}`,
      origin: DASHBOARD,
      referer: `${DASHBOARD}/signin.php`,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      email: env.whatsapp.dashboardEmail,
      password: env.whatsapp.dashboardPassword,
      signin: 'Sign in',
    }),
  });
  const loginJson = await r2.json().catch(() => null);
  if (loginJson?.error) throw new Error(`dashboard login failed: ${loginJson.error}`);
  return cookie;
}

/** The exact POST the dashboard "Extend trial" button fires. */
async function extendTrial(cookie) {
  const res = await fetchWithTimeout(`${DASHBOARD}/request/post.php`, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `PHPSESSID=${cookie}`,
      origin: DASHBOARD,
      referer: `${DASHBOARD}/app/instances/instances.php`,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: new URLSearchParams({ extend_trial: String(env.whatsapp.instanceNumber) }),
  });
  return res.json().catch(() => ({ error: 'non-JSON dashboard response' }));
}

/** At most one alert email per kind per ~20h (watchdog runs hourly). */
async function alertOncePer(kind, subject, text) {
  let existing = null;
  try {
    existing = await WatchdogState.findOne({ key: kind });
  } catch (err) {
    console.error('[watchdog] throttle state failed:', err.message);
  }
  if (existing && Date.now() - existing.lastSentAt.getTime() < ALERT_THROTTLE_MS) {
    return { alerted: false, reason: 'throttled' };
  }
  try {
    await WatchdogState.updateOne(
      { key: kind },
      { $set: { lastSentAt: new Date() } },
      { upsert: true },
    );
  } catch { /* best effort */ }
  try {
    await sendWatchdogAlertEmail({ subject, text });
    return { alerted: true };
  } catch (err) {
    console.error('[watchdog] alert email failed:', err.message);
    return { alerted: false, reason: 'email failed' };
  }
}

/**
 * One watchdog pass. Returns a compact JSON report (safe — no secrets).
 */
/**
 * Public entry (cron-job.org pings this every 5 min). Wraps watchdogPass with
 * heartbeat observability (2026-09-21): every run stamps watchdog:last-run,
 * every SUCCESSFUL renewal stamps watchdog:last-renewal — and the report
 * includes secondsSinceLastPing + lastRenewalAt so anyone hitting the
 * endpoint can PROVE the 5-min cron is alive and see the last time the
 * "Extend trial" button was auto-pressed. Never throws.
 */
export async function runWatchdog() {
  const report = await watchdogPass();
  if (report?.configured === false) return report;
  try {
    const prevPing = await WatchdogState.findOne({ key: 'watchdog:last-run' });
    if (prevPing?.lastSentAt) {
      report.secondsSinceLastPing = Math.round((Date.now() - prevPing.lastSentAt.getTime()) / 1000);
    }
    await WatchdogState.updateOne(
      { key: 'watchdog:last-run' },
      { $set: { lastSentAt: new Date() } },
      { upsert: true },
    );
    if (report.renewed === true) {
      await WatchdogState.updateOne(
        { key: 'watchdog:last-renewal' },
        { $set: { lastSentAt: new Date() } },
        { upsert: true },
      );
    }
    const renewal = await WatchdogState.findOne({ key: 'watchdog:last-renewal' });
    if (renewal?.lastSentAt) {
      report.lastRenewalAt = renewal.lastSentAt instanceof Date ? renewal.lastSentAt.toISOString() : String(renewal.lastSentAt);
    }
  } catch (err) {
    console.error('[watchdog] heartbeat stamp failed:', err.message);
  }
  return report;
}

async function watchdogPass() {
  if (!isWatchdogConfigured()) {
    return { configured: false };
  }

  let raw;
  try {
    raw = await fetchInstanceStatus();
  } catch (err) {
    const alert = await alertOncePer(
      'watchdog:status-unreachable',
      'Tri3M watchdog: UltraMsg status check failed',
      `Status API unreachable: ${err.message}. Gateway alerts may pause — check user.ultramsg.com manually.`,
    );
    return { configured: true, status: 'unreachable', error: err.message, ...alert };
  }

  const health = parseHealth(raw);

  if (health.healthy) {
    return { configured: true, status: health.status, action: 'none', renewed: false };
  }

  if (health.stopped) {
    // trial expired → renew through the dashboard, exactly like the button
    let extendResponse = null;
    try {
      const cookie = await dashboardLogin();
      extendResponse = await extendTrial(cookie);
    } catch (err) {
      const alert = await alertOncePer(
        'watchdog:renew-failed',
        'Tri3M watchdog: trial renewal FAILED',
        `Renewal error: ${err.message}. WhatsApp alerts are paused — log in to user.ultramsg.com → Instances and extend the trial manually.`,
      );
      return {
        configured: true,
        status: health.status,
        action: 'renew',
        renewed: false,
        error: err.message,
        ...alert,
      };
    }

    if (extendResponse?.error) {
      const alert = await alertOncePer(
        'watchdog:renew-failed',
        'Tri3M watchdog: trial renewal FAILED',
        `extend_trial answered: ${extendResponse.error}. WhatsApp alerts are paused — check user.ultramsg.com → Instances.`,
      );
      return {
        configured: true,
        status: health.status,
        action: 'renew',
        renewed: false,
        error: extendResponse.error,
        ...alert,
      };
    }

    // brief verification pass (dashboard payment info settles in minutes;
    // the next hourly ping re-checks anyway)
    await sleep(VERIFY_WAIT_MS);
    let statusAfter = health.status;
    try {
      statusAfter = parseHealth(await fetchInstanceStatus()).status;
    } catch { /* keep the pre-verification status */ }
    return {
      configured: true,
      status: health.status,
      action: 'renew',
      renewed: true,
      extendResponse: { success: extendResponse?.success ?? true },
      statusAfter,
    };
  }

  if (health.needsQr) {
    const alert = await alertOncePer(
      'watchdog:qr',
      'Tri3M watchdog: WhatsApp QR scan needed',
      'UltraMsg ka WhatsApp session drop ho gaya. Dashboard pe login kar ke instance ka QR scan karna hoga (user.ultramsg.com → Instances → instance → Scan QR code). Jab tak alerts ruki hain.',
    );
    return { configured: true, status: 'qr', action: 'none', renewed: false, ...alert };
  }

  // unknown unhealthy state — tell the owner once per 20h
  const alert = await alertOncePer(
    'watchdog:unknown',
    'Tri3M watchdog: unknown gateway status',
    `Instance status: ${health.status}. Check user.ultramsg.com manually.`,
  );
  return { configured: true, status: health.status, action: 'none', renewed: false, ...alert };
}
