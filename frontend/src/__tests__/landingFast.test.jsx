import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Landing from '../pages/Landing.jsx';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, '../pages/Landing.jsx'), 'utf8');
const css = readFileSync(join(here, '../index.css'), 'utf8');
const rootCode = readFileSync(join(here, '../pages/RootRedirect.jsx'), 'utf8');

describe('launch-day public landing performance', () => {
  it('renders all sections and the sign-in CTA immediately without motion observers', () => {
    const html = renderToString(<MemoryRouter><Landing /></MemoryRouter>);
    expect(html).toContain('Sign in to your portal');
    expect(html).toContain('Questions, answered.');
    expect(html).toContain('Attendance live');
    expect(html).toContain('100<!-- -->%');
    expect(html).toContain('Tri3M');
  });

  it('has no recurring hero timers, per-frame counters, scroll repaint listener or motion import', () => {
    expect(code).not.toMatch(/from ['"]motion\/react['"]/);
    expect(code).not.toMatch(/setInterval\(|setTimeout\(|requestAnimationFrame\(|IntersectionObserver\(|addEventListener\(['"]scroll/);
    expect(code).not.toContain('backdrop-blur-xl');
  });

  it('shows the public landing without blocking on /api/auth/me', () => {
    expect(rootCode).toContain('if (ready && isAuthenticated)');
    expect(rootCode).not.toContain('if (!ready) return');
  });

  it('scopes the no-background-animation rule to the landing only', () => {
    expect(code).toContain('landing-fast min-h-dvh');
    expect(css).toContain('.landing-fast [class*="animate-"]');
  });
});
