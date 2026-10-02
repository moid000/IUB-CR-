import { describe, expect, it, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ActivatePage from '../pages/ActivatePage.jsx';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '../pages/ActivatePage.jsx'), 'utf8');

/**
 * 2026-10-02 (owner report): during activation, a user who switches to
 * Gmail for the code and returns to the app found the wizard restarted
 * from the email step — Android/iOS browsers discard backgrounded tabs
 * and reload the page, losing all in-memory wizard state. Fix: the
 * wizard mirrors its position into sessionStorage and rebuilds itself
 * from it on mount. The flow itself (Email → Confirm details → Verify
 * code → Set password) is completely unchanged.
 *
 * The node test env has no sessionStorage — a minimal stub lets us
 * render the exact "page reloaded with saved state" scenario.
 */

const store = (() => {
  let m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m = new Map(); },
  };
})();
globalThis.sessionStorage = store;

const PROFILE = { name: 'Test Student', email: 'test@example.com', section: '3M', rollNo: '01' };
const KEY = 'tri3m:activate:student';

const render = () => renderToString(
  <MemoryRouter><ActivatePage role="student" /></MemoryRouter>
);

const seed = (obj) => store.setItem(KEY, JSON.stringify(obj));

beforeEach(() => store.clear());

describe('activation resume — a reloaded tab picks up where it left off', () => {
  it('resumes at the OTP step (the Gmail-switch case) with a welcome-back notice', () => {
    // sent 61s ago → cooldown over, resend button enabled
    seed({ step: 2, email: 'test@example.com', profile: PROFILE, otpSentAt: Date.now() - 61000, activationToken: null });
    const html = render();
    expect(html).toContain('Welcome back — we picked up right where you left off.');
    expect(html).toContain('Verify code');
    expect(html).toContain('Resend code');
  });

  it('keeps the resend countdown across the reload instead of leaving it stuck', () => {
    // sent 30s ago → ~30s of cooldown remain
    seed({ step: 2, email: 'test@example.com', profile: PROFILE, otpSentAt: Date.now() - 30000, activationToken: null });
    const html = render();
    expect(html).toContain('Resend available in 3');
  });

  it('warns when the restored OTP is older than the 10-minute TTL', () => {
    seed({ step: 2, email: 'test@example.com', profile: PROFILE, otpSentAt: Date.now() - 11 * 60 * 1000, activationToken: null });
    const html = render();
    expect(html).toContain('Your code may have expired — request a new one.');
  });

  it('resumes at the password step once the code was verified', () => {
    seed({ step: 3, email: 'test@example.com', profile: PROFILE, otpSentAt: null, activationToken: 'activation-jwt' });
    const html = render();
    expect(html).toContain('Set password &amp; activate');
    expect(html).toContain('New password');
  });

  it('never resumes a half-saved snapshot (step 3 without a token) — falls back to a clean start', () => {
    seed({ step: 3, email: 'test@example.com', profile: PROFILE, otpSentAt: null, activationToken: undefined });
    const html = render();
    expect(html).toContain('you@example.com'); // step 0 email screen
    expect(html).not.toContain('Welcome back');
  });

  it('never resumes from the success step — completion is always a clean slate', () => {
    seed({ step: 4, email: 'test@example.com', profile: PROFILE, activationToken: 'x' });
    const html = render();
    expect(html).toContain('you@example.com');
    expect(html).not.toContain('Account activated');
  });

  it('keeps roles isolated — a CR snapshot must not leak into the student flow', () => {
    store.setItem('tri3m:activate:cr', JSON.stringify({ step: 2, email: 'cr@example.com', profile: PROFILE, otpSentAt: Date.now() }));
    const html = render();
    expect(html).toContain('you@example.com'); // student page still at step 0
  });
});

describe('activation resume — persistence contract (source-level)', () => {
  it('saves under a role-scoped sessionStorage key', () => {
    expect(code).toContain('tri3m:activate:');
  });

  it('persists exactly the snapshot the loader validates', () => {
    expect(code).toContain('JSON.stringify({ step, email, profile, activationToken, otpSentAt })');
  });

  it('clears the snapshot on completion and on expiry (401), never resuming a used flow', () => {
    // success (step 4) and fresh (step 0, empty email) both remove the key
    expect(code).toMatch(/sessionStorage\.removeItem\(activationSaveKey\(role\)\); \/\/ fresh start or activation finished/);
    // an expired verification token restarts cleanly instead of a dead end
    expect(code).toContain('err?.status === 401');
    expect(code).toContain('Your verification window expired.');
  });

  it('does not change the flow itself — same four steps in the same order', () => {
    expect(code).toContain("const STEPS = ['Email', 'Confirm details', 'Verify code', 'Set password'];");
  });
});
