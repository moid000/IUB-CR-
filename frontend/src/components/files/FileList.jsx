import { useState } from 'react';
import { ImageLightbox } from './ImageLightbox.jsx';
import { Button } from '../ui/Button.jsx';
import { IconDownload, IconFileText, IconPaperclip, IconX } from '../icons.jsx';
import { formatBytes, thumbUrl, typeLabel } from '../../api/upload.js';

/**
 * STEP 18 — confirmed attachment display (read-only by default).
 * File cards show icon/thumbnail, name, `TYPE · size` and Open/Download
 * actions. Images open a lightbox; PDFs/documents open in a new tab via
 * their verified HTTPS URL. No raw Cloudinary URL text is ever shown.
 */
export function FileList({ files = [], emptyText = null, className = '', onRemove = null, removeBusyId = null }) {
  const [preview, setPreview] = useState(null);
  const list = files.filter(Boolean);
  if (list.length === 0 && !emptyText) return null;

  if (list.length === 0 && emptyText) {
    return <p className={`text-xs text-slate-400 ${className}`}>{emptyText}</p>;
  }

  return (
    <>
      <ul className={`space-y-2 ${className}`} aria-label="Attachments">
        {list.map((f) => {
          const isImage = f.resourceType === 'image' || ['png', 'jpg', 'jpeg', 'webp'].includes(f.format);
          return (
            <li key={f._id ?? f.publicId} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {isImage ? (
                  <button
                    type="button"
                    onClick={() => setPreview(f)}
                    aria-label={`Preview ${f.originalName ?? 'image'}`}
                    className="size-11 shrink-0 overflow-hidden rounded-lg border border-slate-100"
                  >
                    <img
                      src={thumbUrl(f.url, 96)} alt={f.originalName ?? 'attachment'}
                      loading="lazy"
                      className="size-full object-cover"
                      onError={(e) => { e.currentTarget.replaceWith(Object.assign(document.createElement('span'), { className: 'grid size-full place-items-center text-[10px] font-bold text-slate-400', textContent: typeLabel(f.format) })); }}
                    />
                  </button>
                ) : (
                  <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-slate-100 text-[10px] font-bold tracking-wide text-slate-500">
                    {typeLabel(f.format).slice(0, 4)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{f.originalName ?? 'Attachment'}</p>
                  <p className="text-xs text-slate-400">{typeLabel(f.format)} · {formatBytes(f.size)}</p>
                </div>
              </div>
              <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1 sm:w-auto">
                {onRemove && (
                  <Button
                    variant="ghost" size="sm" icon={IconX}
                    aria-label={`Remove ${f.originalName ?? 'attachment'}`}
                    disabled={removeBusyId === (f._id ?? f.publicId)}
                    onClick={() => onRemove(f)}
                  >Remove</Button>
                )}
                {isImage && (
                  <Button variant="ghost" size="sm" onClick={() => setPreview(f)}>Preview</Button>
                )}
                <a
                  href={f.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
                  aria-label={`Open ${f.originalName ?? 'file'} in a new tab`}
                >
                  <IconDownload className="size-3.5" aria-hidden="true" />Open
                </a>
              </div>
            </li>
          );
        })}
      </ul>

      {/* zoomable image lightbox — pinch/wheel/double-tap zoom, one-finger pan */}
      {preview && <ImageLightbox file={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

/**
 * Attachment count pill — a small, self-contained badge (own background,
 * normal case) so it never inherits a parent row's uppercase/caption
 * styling and never runs into surrounding text. Used on list cards across
 * Announcements/Assignments/Notes/Submissions, student + CR portals.
 */
export function FileChips({ files = [], className = '' }) {
  const list = files.filter(Boolean);
  if (list.length === 0) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-slate-500 ${className}`}
    >
      <IconPaperclip className="size-3" aria-hidden="true" />
      {list.length} {list.length === 1 ? 'file' : 'files'}
    </span>
  );
}

