/**
 * Shared Cloudinary direct-upload helpers (STEP 18).
 * The browser ALWAYS follows: sign → direct upload → confirm. No file bytes
 * ever reach the app's API, and no Cloudinary secret is ever client-side.
 */

/** Client mirror of the server allowlist — friendly errors BEFORE the network. */
export const ALLOWED_TYPES = [
  { ext: 'pdf', mime: 'application/pdf', label: 'PDF' },
  { ext: 'png', mime: 'image/png', label: 'PNG' },
  { ext: 'jpg', mime: 'image/jpeg', label: 'JPG' },
  { ext: 'jpeg', mime: 'image/jpeg', label: 'JPEG' },
  { ext: 'webp', mime: 'image/webp', label: 'WEBP' },
  { ext: 'gif', mime: 'image/gif', label: 'GIF' },
  { ext: 'doc', mime: 'application/msword', label: 'DOC' },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'DOCX' },
  { ext: 'ppt', mime: 'application/vnd.ms-powerpoint', label: 'PPT' },
  { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PPTX' },
  { ext: 'xls', mime: 'application/vnd.ms-excel', label: 'XLS' },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'XLSX' },
  { ext: 'txt', mime: 'text/plain', label: 'TXT' },
  { ext: 'csv', mime: 'text/csv', label: 'CSV' },
  { ext: 'rtf', mime: ['application/rtf', 'text/rtf'], label: 'RTF' },
  { ext: 'zip', mime: ['application/zip', 'application/x-zip-compressed'], label: 'ZIP' },
  { ext: 'rar', mime: ['application/vnd.rar', 'application/x-rar-compressed', 'application/rar'], label: 'RAR' },
  { ext: '7z', mime: 'application/x-7z-compressed', label: '7Z' },
  { ext: 'mp3', mime: 'audio/mpeg', label: 'MP3' },
  { ext: 'wav', mime: ['audio/wav', 'audio/x-wav'], label: 'WAV' },
  { ext: 'm4a', mime: ['audio/mp4', 'audio/x-m4a'], label: 'M4A' },
  { ext: 'ogg', mime: ['audio/ogg', 'application/ogg'], label: 'OGG' },
  { ext: 'aac', mime: ['audio/aac', 'audio/x-aac'], label: 'AAC' },
  { ext: 'flac', mime: 'audio/flac', label: 'FLAC' },
  { ext: 'mp4', mime: 'video/mp4', label: 'MP4' },
  { ext: 'mkv', mime: 'video/x-matroska', label: 'MKV' },
  { ext: 'mov', mime: ['video/quicktime', 'video/x-quicktime'], label: 'MOV' },
  { ext: 'avi', mime: ['video/x-msvideo', 'video/avi'], label: 'AVI' },
  { ext: 'webm', mime: ['video/webm', 'audio/webm'], label: 'WEBM' },
];

export const AVATAR_TYPES = [
  { ext: 'png', mime: 'image/png', label: 'PNG' },
  { ext: 'jpg', mime: 'image/jpeg', label: 'JPG' },
  { ext: 'jpeg', mime: 'image/jpeg', label: 'JPEG' },
  { ext: 'webp', mime: 'image/webp', label: 'WEBP' },
];

export const ACCEPT_ATTR = ALLOWED_TYPES.map((t) => `.${t.ext}`).join(',');
export const ACCEPT_AVATAR_ATTR = AVATAR_TYPES.map((t) => `.${t.ext}`).join(',');

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** extension ↔ MIME pair must BOTH match (mirrors the server rule). */
export function matchType(file, types = ALLOWED_TYPES) {
  const name = String(file?.name ?? '').trim();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const mime = String(file?.type ?? '').trim().toLowerCase();
  return types.find((t) => t.ext === ext
    && (t.mime === mime || (Array.isArray(t.mime) && t.mime.includes(mime)))) ?? null;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function typeLabel(format) {
  return String(format ?? '').toUpperCase() || 'FILE';
}

/** Friendly error text — NEVER raw provider/internal messages (spec T). */
export function friendlyUploadError(err, fallback = 'Upload failed. Please try again.') {
  const status = err?.status ?? err?.response?.status;
  const msg = String(err?.message ?? err ?? '');
  if (status === 401 || /session|sign in|unauthor/i.test(msg)) {
    return 'Your session has expired. Please sign in again.';
  }
  if (/confirm/i.test(msg) || status === 400 && /confirm/i.test(msg)) {
    return "We couldn't confirm this file. Please try again.";
  }
  if (/Unsupported file type/i.test(msg)) return "This file type isn't supported.";
  if (/Attachment limit/i.test(msg)) return 'You can attach up to 10 files.';
  if (/temporarily unavailable/i.test(msg)) return 'Uploads are temporarily unavailable. Please try again later.';
  return fallback;
}

/**
 * Browser-direct upload to Cloudinary with progress. Resolves with the
 * provider result; rejects with a sanitized Error.
 */
export function uploadToCloudinary(signData, file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', signData.uploadUrl);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* malformed */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error?.message ?? 'Upload failed'));
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    const fd = new FormData();
    fd.append('api_key', signData.apiKey);
    fd.append('timestamp', signData.timestamp);
    fd.append('signature', signData.signature);
    fd.append('folder', signData.folder);
    fd.append('public_id', signData.publicId);
    fd.append('file', file);
    xhr.send(fd);
  });
}

/** Cloudinary thumbnail transform for images (same host, HTTPS, cheap). */
export function thumbUrl(url, w = 240) {
  if (!url) return url;
  return url.replace('/upload/', `/upload/w_${w},c_fill,ar_1,f_auto,q_auto/`);
}

/**
 * Best filename for a Save/Download action — keeps the original upload name;
 * if it has no extension (or none was stored), appends the stored format so
 * Android/Windows know how to open it and gallery apps index it correctly.
 */
export function downloadName(f) {
  const base = (f?.originalName || 'download').replace(/[\r\n\/]+/g, '_').trim() || 'download';
  if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
  const ext = (f?.format || '').toLowerCase();
  return ext ? `${base}.${ext}` : base;
}

/**
 * Cloudinary "force download" URL — inserts the `fl_attachment` flag so
 * Cloudinary's SERVER responds with `Content-Disposition: attachment`.
 *
 * Fixed 2026-09-22 (owner screenshot): the previous approach fetched the
 * file as a blob and clicked an `<a download>` on the resulting blob: URL.
 * Blob-URL downloads of IMAGES are exactly what makes Android Chrome pop
 * open its own floating "photo viewer" overlay (zoom controls, refresh, X)
 * ON TOP of the page — that's the ugly translucent panel with our app
 * bleeding through behind it in the screenshot. A real HTTP response with
 * a `Content-Disposition: attachment` header downloads silently instead —
 * no viewer, no new tab, no CORS fetch needed at all.
 */
export function attachmentUrl(url, filename) {
  if (!url) return url;
  const base = String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  const flag = base ? `fl_attachment:${encodeURIComponent(base)}` : 'fl_attachment';
  return url.includes('/upload/') ? url.replace('/upload/', `/upload/${flag}/`) : url;
}

/**
 * Saves a file to the device via a real forced-download navigation (see
 * attachmentUrl above) — no popup viewer, no blob/CORS round trip, so the
 * browser starts the download the instant this is called (no user-visible
 * wait before something happens).
 */
export function downloadFile(url, name = 'download') {
  const href = attachmentUrl(url, name);
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Full-image preview (lightbox) transform — caps the LONG edge at `w` px
 * without cropping (c_limit keeps the original aspect ratio; a portrait
 * photo stays portrait). Fixes 2026-09-22: the lightbox used to load the
 * raw original (some phone photos are 4000x3000px, several MB) — every
 * pinch-zoom/pan repaint had to re-decode that at scaled resolution, which
 * is what felt "very slow" moving/zooming. 1600px is already sharper than
 * any phone screen can show, so quality is unaffected.
 */
export function previewUrl(url, w = 1600) {
  if (!url) return url;
  return url.replace('/upload/', `/upload/w_${w},c_limit,f_auto,q_auto/`);
}
