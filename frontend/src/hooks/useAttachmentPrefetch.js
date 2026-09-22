import { useEffect } from 'react';
import { thumbUrl } from '../api/upload.js';

const isImage = (f) => f?.resourceType === 'image'
  || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(String(f?.format ?? '').toLowerCase());

/** Start the exact 96px URLs used inside FileList before a modal opens. */
export function warmAttachmentImages(files = [], limit = 4) {
  if (typeof Image === 'undefined') return;
  let count = 0;
  for (const file of files) {
    if (!isImage(file) || !file?.url || count >= limit) continue;
    const img = new Image();
    img.decoding = 'async';
    img.src = thumbUrl(file.url, 96);
    count += 1;
  }
}

/**
 * Idle-prefetch a small, data-conscious set of image thumbnails for visible
 * cards. No originals are downloaded; only the tiny URL FileList will use.
 */
export default function useAttachmentPrefetch(items = [], limit = 8) {
  useEffect(() => {
    if (!items.length || typeof window === 'undefined') return undefined;
    const connection = navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection;
    if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return undefined;

    const run = () => {
      let remaining = limit;
      for (const item of items) {
        if (remaining <= 0) break;
        const images = (item?.attachments ?? []).filter(isImage).slice(0, remaining);
        warmAttachmentImages(images, remaining);
        remaining -= images.length;
      }
    };
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(run, { timeout: 900 });
      return () => window.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(run, 120);
    return () => window.clearTimeout(id);
  }, [items, limit]);
}
