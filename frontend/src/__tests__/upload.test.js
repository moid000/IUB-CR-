import { describe, it, expect } from 'vitest';
import { thumbUrl, previewUrl, attachmentUrl, downloadName } from '../api/upload.js';

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

// 2026-09-22 (owner screenshot): Save/Download used to fetch the file as a
// blob and click <a download> on the blob: URL — on Android Chrome this
// pops the browser's OWN floating "photo viewer" (zoom controls, X) on top
// of the page, with the app bleeding through behind it (the ugly
// screenshot). Fix: Cloudinary's `fl_attachment` flag makes Cloudinary's
// SERVER send Content-Disposition: attachment, so the browser downloads
// silently — no viewer, no blob, no CORS fetch.
describe('attachmentUrl (forced-download, no popup viewer)', () => {
  const raw = 'https://res.cloudinary.com/demo/image/upload/v1/iub/timetable.jpg';

  it('inserts a plain fl_attachment flag when no filename given', () => {
    expect(attachmentUrl(raw)).toBe(
      'https://res.cloudinary.com/demo/image/upload/fl_attachment/v1/iub/timetable.jpg'
    );
  });

  it('inserts fl_attachment:<encoded filename> (extension stripped) when given', () => {
    const out = attachmentUrl(raw, 'Section 3M Timetable.jpg');
    expect(out).toContain('fl_attachment:Section%203M%20Timetable/');
    expect(out).not.toContain('fl_attachment/'); // the bare-flag form, not present
  });

  it('never crops/resizes — full original quality for a real download', () => {
    expect(attachmentUrl(raw, 'x.jpg')).not.toContain('c_limit');
    expect(attachmentUrl(raw, 'x.jpg')).not.toContain('c_fill');
  });

  it('passes through non-Cloudinary or falsy URLs unchanged', () => {
    expect(attachmentUrl(null)).toBe(null);
    expect(attachmentUrl('https://example.com/f.pdf', 'f')).toBe('https://example.com/f.pdf');
  });
});
