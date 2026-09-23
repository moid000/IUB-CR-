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
  it('renders the teacher workflows, roadmap and CTA in static HTML', () => {
    const html = renderToString(<MemoryRouter><Landing /></MemoryRouter>);
    expect(html).toContain('Sign in to your portal');
    expect(html).toContain('Questions, answered.');
    expect(html).toContain('Attendance live');
    expect(html).toContain('100<!-- -->%');
    expect(html).toContain('Tri3M');
    expect(html).toContain('Teachers stay in the loop');
    expect(html).toContain('Deadlines report themselves');
    expect(html).toContain('One post reaches the group');
    expect(html).toContain('Attendance · In development');
    expect(html).toContain('These extra safeguards are not live yet.');
  });

  it('uses one visibility observer without per-frame JS or scroll repaint', () => {
    expect(code).not.toMatch(/from ['"]motion\/react['"]/);
    expect(code).not.toMatch(/setInterval\(|setTimeout\(|requestAnimationFrame\(|addEventListener\(['"]scroll/);
    expect(code.match(/new IntersectionObserver\(/g)).toHaveLength(1);
    expect(code).toContain('observer.disconnect()');
    expect(code).not.toContain('backdrop-blur-xl');
  });

  it('shows the public landing without blocking on /api/auth/me', () => {
    expect(rootCode).toContain('if (ready && isAuthenticated)');
    expect(rootCode).not.toContain('if (!ready) return');
  });

  it('scopes animations to visible landing sections, respects reduced motion', () => {
    expect(code).toContain('landing-fast min-h-dvh');
    expect(css).toContain('main section:not(.landing-active) [class*="animate-"]');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (hover: hover) and (pointer: fine)');
    expect(css).toContain('landing-low-motion');
    expect(code).toContain('navigator.connection?.saveData');
  });
});
