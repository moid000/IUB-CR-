import { describe, it, expect } from 'vitest';
import { thumbUrl, previewUrl } from '../api/upload.js';

// 2026-09-22: lightbox preview lag — the old lightbox loaded the RAW original
// (some phone photos are 4000x3000px) instead of a capped-resolution version,
// so every pinch-zoom/pan repaint re-decoded a huge image. previewUrl caps the
// long edge WITHOUT cropping (thumbUrl force-crops to a square via c_fill/ar_1
// — wrong for a full-image preview, which must keep the original aspect ratio).
describe('previewUrl', () => {
  const raw = 'https://res.cloudinary.com/demo/image/upload/v1/iub/foo.jpg';

  it('inserts a capped, non-cropping width transform', () => {
    expect(previewUrl(raw, 1600)).toBe(
      'https://res.cloudinary.com/demo/image/upload/w_1600,c_limit,f_auto,q_auto/v1/iub/foo.jpg'
    );
  });

  it('defaults to 1600px when no width given', () => {
    expect(previewUrl(raw)).toContain('w_1600,c_limit');
  });

  it('never forces a square crop (c_fill/ar_1) like thumbUrl does', () => {
    expect(previewUrl(raw)).not.toContain('c_fill');
    expect(previewUrl(raw)).not.toContain('ar_1');
  });

  it('passes through falsy input unchanged', () => {
    expect(previewUrl(null)).toBe(null);
    expect(previewUrl(undefined)).toBe(undefined);
  });

  it('thumbUrl (list thumbnails) still crops to a square — different use case', () => {
    expect(thumbUrl(raw, 96)).toContain('c_fill,ar_1');
  });
});
