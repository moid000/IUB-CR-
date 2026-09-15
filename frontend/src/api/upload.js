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
  { ext: 'doc', mime: 'application/msword', label: 'DOC' },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'DOCX' },
  { ext: 'ppt', mime: 'application/vnd.ms-powerpoint', label: 'PPT' },
  { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PPTX' },
  { ext: 'xls', mime: 'application/vnd.ms-excel', label: 'XLS' },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'XLSX' },
  { ext: 'txt', mime: 'text/plain', label: 'TXT' },
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
  return types.find((t) => t.ext === ext && t.mime === mime) ?? null;
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
