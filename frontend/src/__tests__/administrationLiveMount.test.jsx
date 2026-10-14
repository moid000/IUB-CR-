// @vitest-environment jsdom
/**
 * ADMINISTRATION PAGE LIVE CRASH REPRO (owner report 2026-10-14 21:35 PKT):
 * the page hits the per-page RouteErrorBoundary card ("This page couldn't
 * load") for the OWNER in production. renderToString (adminPageCrash test)
 * runs NO effects — so it can never see crashes that happen on the re-render
 * AFTER data arrives (effect -> setState -> render). This test mounts the
 * real page in jsdom, lets the effects run with LIVE-shaped API responses,
 * and catches any deterministic render crash.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('../api/admin.js', () => ({
  adminApi: {
    administration: {
      getProfile: vi.fn(async () => ({ success: true, data: {
        configured: true,
        profile: { name: 'Abdul Moid', email: 'admin@example.com',
          whatsapp: '923085861117', updatedAt: '2026-10-01T10:00:00Z' },
      } })),
      updateProfile: vi.fn(async () => ({})),
    },
    chatbot: {
      get: vi.fn(async () => ({ success: true, data: {
        enabled: true, apiKeyConfigured: true, apiKeySource: 'env',
        openaiKeyConfigured: false, openaiKeySource: 'none',
        geminiKeysCount: 0, geminiKeysMasked: [], apiKeyPoolCount: 1,
      } })),
      update: vi.fn(async () => ({})),
    },
    experience: {
      get: vi.fn(async () => ({ success: true, data: {
        classify: { seed: 12, real: 34 }, chat: { seed: 9, real: 56 },
        lastRefreshAt: '2026-10-14T12:00:00Z',
      } })),
      refresh: vi.fn(async () => ({ data: {} })),
    },
  },
}));
vi.mock('../api/client.js', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));

const { default: AdministrationPage } = await import('../pages/admin/AdministrationPage.jsx');

describe('AdministrationPage live mount (effects run)', () => {
  it('mounts, fetches, re-renders with data, and does NOT crash', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const errors = [];
    const origError = console.error;
    console.error = (...a) => errors.push(a.map(String).join(' '));
    const container = document.createElement('div');
    document.body.appendChild(container);
    let threw = null;
    try {
      await act(async () => { createRoot(container).render(<AdministrationPage />); });
      // flush every effect-triggered promise/microtask + any async state
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    } catch (err) {
      threw = err;
    }
    console.error = origError;
    const html = container.innerHTML;
    expect(threw).toBe(null);
    // data actually painted (profile + bot card + experience stats)
    expect(html).toContain('Administration profile');
    expect(html).toContain('Gemini API keys (quota pool)');
    // no React error log (boundary-style crash evidence)
    const reactErrors = errors.filter((e) => e.includes('Tri3M') || e.includes('The above error occurred'));
    expect(reactErrors).toEqual([]);
  });
});
