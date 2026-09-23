import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

/**
 * Owner screenshot 2026-09-23 (recurring): dashboard sometimes rendered
 * "zoomed out" with empty grey side margins. A first attempt fixed this by
 * locking the page-level viewport (user-scalable=no) and adding
 * overflow-x:hidden on html/body -- but that broke ALL page scrolling on
 * device and had to be fully reverted. This safer follow-up scopes overflow
 * containment to each portal's own app-shell wrapper div (a normal block
 * element, never the browser's root scrolling element) so an accidental
 * hair-wider-than-viewport element gets clipped WITHOUT touching html/body
 * or the viewport meta -- both suspected in the scroll-lock regression.
 */
describe('portal shells contain horizontal overflow without touching the document root', () => {
  it.each([
    'student/StudentLayout.jsx',
    'cr/CrLayout.jsx',
    'admin/AdminLayout.jsx',
  ])('%s wraps its shell in overflow-x-hidden', (rel) => {
    const code = src(rel);
    expect(code).toContain('min-h-dvh overflow-x-hidden bg-slate-50');
  });

  it('viewport meta stays permissive (no user-scalable=no, no maximum-scale lock)', () => {
    const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');
    const meta = html.split('\n').find((l) => l.includes('name="viewport"'));
    expect(meta).toContain('width=device-width, initial-scale=1.0');
    expect(meta).not.toContain('user-scalable');
    expect(meta).not.toContain('maximum-scale');
  });

  it('html/body keep default overflow (no global overflow-x:hidden that previously broke scrolling)', () => {
    const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
    const htmlBlock = css.slice(css.indexOf('html {'), css.indexOf('body {'));
    const bodyBlock = css.slice(css.indexOf('body {'), css.indexOf('body {') + 200);
    expect(htmlBlock).not.toContain('overflow-x');
    expect(bodyBlock).not.toContain('overflow-x');
  });
});
