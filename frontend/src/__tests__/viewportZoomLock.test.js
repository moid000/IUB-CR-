import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Owner screenshot 2026-09-23: the dashboard sometimes rendered "zoomed
 * out" with empty grey margins on both sides (an accidental page-level
 * pinch-zoom, or mobile Safari auto-shrinking the initial scale to fit any
 * element a hair wider than the viewport). The app already builds its OWN
 * zoom UI where zoom is useful (ImageLightbox has touch-none + custom
 * pinch/pan) so native whole-page zoom is never needed and only causes this
 * bug. Guard both the viewport lock and the overflow-x safety net.
 */
describe('page-level pinch zoom is locked and horizontal overflow is guarded', () => {
  it('index.html viewport meta disables user scaling', () => {
    const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');
    const meta = html.split('\n').find((l) => l.includes('name="viewport"'));
    expect(meta).toBeTruthy();
    expect(meta).toContain('width=device-width');
    expect(meta).toContain('maximum-scale=1.0');
    expect(meta).toContain('user-scalable=no');
  });

  it('html and body both guard against a hair-wider-than-viewport element', () => {
    const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
    const htmlBlock = css.slice(css.indexOf('html {'), css.indexOf('body {'));
    const bodyBlock = css.slice(css.indexOf('body {'), css.indexOf('body {') + 400);
    expect(htmlBlock).toContain('overflow-x: hidden');
    expect(bodyBlock).toContain('overflow-x: hidden');
  });

  it('ImageLightbox keeps its own isolated touch handling (unaffected by the page-level lock)', () => {
    const code = readFileSync(join(__dirname, '..', 'components/files/ImageLightbox.jsx'), 'utf8');
    expect(code).toContain('touch-none');
  });
});
