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

  // OWNER ORDER 2026-10-07: page zoom is now deliberately LOCKED (pinch in/out
  // disabled) so the page keeps a fixed size/position on phones — the owner was
  // accidentally pinch-zooming and the whole layout (incl. bottom tab bar)
  // shifted. Compensations already in place: 16px form inputs (no focus zoom)
  // and the image lightbox keeps its OWN internal zoom via touch-action: none.
  it('viewport meta locks the page scale (owner order 2026-10-07)', () => {
    const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');
    const meta = html.split('\n').find((l) => l.includes('name="viewport"'));
    expect(meta).toContain('width=device-width, initial-scale=1.0');
    expect(meta).toContain('maximum-scale=1.0');
    expect(meta).toContain('user-scalable=no');
  });

  it('index.css blocks native double-tap zoom (touch-action: manipulation on html)', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'src', 'index.css'), 'utf8');
    expect(css).toMatch(/html\s*\{[^}]*touch-action:\s*manipulation/);
  });

  // OWNER ORDER 2026-10-07 (Students page pan report): the page must never
  // pan left-right — the root now hard-clips horizontal overflow with
  // overflow-x: clip. CLIP is the safe primitive: unlike overflow-x:hidden
  // (which made html/body a scroll container and broke all mobile scrolling,
  // reverted), clip clips WITHOUT creating a scroll container, so vertical
  // scrolling is untouched. hidden/scroll/auto at the root stay banned.
  it('root hard-clips horizontal pan with overflow-x: clip (never hidden/scroll/auto)', () => {
    const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
    expect(css).toMatch(/html,\s*body\s*\{\s*overflow-x:\s*clip\s*;?\s*\}/);
    expect(css).not.toMatch(/overflow-x:\s*(hidden|scroll|auto)\s*;/);
  });
});
