import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button.jsx';
import { IconPlus, IconX, IconArrowPath } from '../icons.jsx';
import {
  ACCEPT_ATTR, MAX_FILE_BYTES, formatBytes, friendlyUploadError, matchType, uploadToCloudinary,
} from '../../api/upload.js';

let uid = 0;

/**
 * STEP 18 — reusable FileUploader (drag & drop + picker + progress + retry).
 *
 * Secure flow per file:  sign → browser-direct Cloudinary upload → confirm.
 * The parent (and therefore folder/publicId/ownership) is always chosen by
 * the SERVER — the uploader only supplies originalName/mimeType.
 *
 * States per entry: selected → uploading → done / failed. Client-side
 * validation mirrors the server allowlist; the backend stays authoritative.
 * Uploads fire exactly once per entry (queue pump), so re-renders can never
 * duplicate an upload.
 */
export function FileUploader({
  parentType,
  parentId,
  api, // { sign(body), confirm(body), remove?(body) }
  existing = [], // already-confirmed attachments on this parent
  onAttached = () => {},
  onRemoved = () => {},
  maxFiles = 10,
  disabled = false,
  label = 'Attachments',
  hint = 'PDF, images, Word, PowerPoint, Excel or text — up to 10 MB each, max 10 files.',
}) {
  const [queue, setQueue] = useState([]); // { key, file, status, progress, error, meta, previewUrl }
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState(null);
  const [removeBusyKey, setRemoveBusyKey] = useState(null);
  const inputRef = useRef(null);
  const busyRef = useRef(false); // one upload at a time
  const objUrlsRef = useRef(new Set()); // preview object URLs — always revoked
  const stateRef = useRef({ queue: [], existing: [] });
  stateRef.current = { queue, existing };

  // Revoke ALL preview object URLs on unmount (no memory leaks — spec AA)
  useEffect(() => {
    const urls = objUrlsRef.current;
    return () => { for (const u of urls) URL.revokeObjectURL(u); urls.clear(); };
  }, []);

  const addFiles = (fileList) => {
    if (disabled) return;
    const files = [...fileList];
    const accepted = [];
    let rejectMsg = null;
    for (const f of files) {
      if (!matchType(f)) { rejectMsg = "This file type isn't supported."; continue; }
      if (f.size > MAX_FILE_BYTES) { rejectMsg = 'File must be 10 MB or smaller.'; continue; }
      // count against confirmed attachments + active queue + this batch
      const { queue: q, existing: ex } = stateRef.current;
      const activeCount = q.filter((e) => e.status !== 'done').length;
      if (ex.length + q.filter((e) => e.status === 'done').length + activeCount + accepted.length + 1 > maxFiles) {
        rejectMsg = `You can attach up to ${maxFiles} files.`;
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length) {
      setQueue((q) => [...q, ...accepted.map((f) => {
        const previewUrl = f.type?.startsWith('image/') ? URL.createObjectURL(f) : null;
        if (previewUrl) objUrlsRef.current.add(previewUrl);
        return {
          key: `f${++uid}-${f.name}-${f.size}`,
          file: f, status: 'selected', progress: 0, error: null, meta: null, previewUrl,
        };
      })]);
    }
    setNotice(rejectMsg);
  };

  const patchEntry = (key, patch) => {
    setQueue((q) => q.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  };

  const runUpload = async (entry) => {
    patchEntry(entry.key, { status: 'uploading', progress: 0, error: null });
    try {
      const sign = (await api.sign({
        parentType, parentId,
        file: { originalName: entry.file.name, mimeType: entry.file.type },
      }))?.data;
      const result = await uploadToCloudinary(sign, entry.file, (p) => {
        patchEntry(entry.key, { progress: p });
      });
      const meta = (await api.confirm({ parentType, parentId, result }))?.data;
      patchEntry(entry.key, { status: 'done', meta, progress: 100 });
      onAttached(meta);
    } catch (err) {
      patchEntry(entry.key, { status: 'failed', error: friendlyUploadError(err) });
    }
  };

  // queue pump — starts exactly one upload for the next 'selected' entry
  useEffect(() => {
    if (busyRef.current) return;
    const next = queue.find((e) => e.status === 'selected');
    if (!next) return;
    busyRef.current = true;
    runUpload(next).finally(() => { busyRef.current = false; });
  }, [queue]); // eslint-disable-line react-hooks/exhaustive-deps

  const revokePreview = (url) => {
    if (url && objUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      objUrlsRef.current.delete(url);
    }
  };

  const removeFromQueue = (entry) => {
    revokePreview(entry.previewUrl);
    setQueue((q) => q.filter((e) => e.key !== entry.key));
  };

  /* Remove a CONFIRMED attachment from the parent (server-side, audited). */
  const removeConfirmed = async (entry) => {
    if (!api.remove || !entry.meta?.publicId) return;
    setRemoveBusyKey(entry.key);
    try {
      await api.remove({ parentType, parentId, publicId: entry.meta.publicId });
      onRemoved(entry.meta.publicId);
      removeFromQueue(entry);
    } catch (err) {
      patchEntry(entry.key, { error: friendlyUploadError(err, "We couldn't remove this file. Please try again.") });
    } finally {
      setRemoveBusyKey(null);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (!disabled) addFiles(e.dataTransfer?.files ?? []);
  };

  const doneCount = queue.filter((e) => e.status === 'done').length;
  const failedCount = queue.filter((e) => e.status === 'failed').length;
  const uploading = queue.some((e) => e.status === 'uploading');

  return (
    <div>
      <span id="file-uploader-label" className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>

      {/* ---- drop zone + picker (keyboard accessible) ---- */}
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby="file-uploader-label"
        aria-describedby={notice ? 'file-uploader-notice' : undefined}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click(); }
        }}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors
          ${disabled ? 'cursor-not-allowed border-slate-200 bg-slate-50/60 text-slate-400'
            : dragging ? 'border-primary-500 bg-primary-50/60'
              : 'border-slate-300 bg-white hover:border-primary-400 hover:bg-slate-50'}`}
      >
        <IconPlus className="size-5 text-slate-400" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-600">
          <span className="underline decoration-slate-400 underline-offset-2">Choose files</span> or drag &amp; drop
        </p>
        <p className="text-xs text-slate-400">{hint}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          aria-label="Choose files to upload"
          className="sr-only"
          tabIndex={-1}
          disabled={disabled}
          onChange={(e) => { addFiles(e.target.files ?? []); e.target.value = ''; }}
        />
      </div>

      {notice && (
        <p id="file-uploader-notice" role="alert" className="mt-2 text-xs font-medium text-red-600">{notice}</p>
      )}

      {/* ---- upload queue ---- */}
      {queue.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Selected files">
          {queue.map((entry) => {
            const f = entry.file;
            const isImage = f.type?.startsWith('image/');
            return (
              <li key={entry.key} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
                {isImage && entry.previewUrl ? (
                  <img src={entry.previewUrl} alt="" loading="lazy" className="size-11 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-slate-100 text-[10px] font-bold tracking-wide text-slate-500">
                    {(f.name.split('.').pop() ?? '?').toUpperCase().slice(0, 4)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{f.name}</p>
                  <p className="text-xs text-slate-400">{formatBytes(f.size)}</p>

                  {entry.status === 'uploading' && (
                    <div className="mt-1.5" role="status" aria-label={`Uploading ${f.name}`}>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${entry.progress}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">Uploading… {entry.progress}%</p>
                    </div>
                  )}
                  {entry.status === 'done' && (
                    <p role="status" className="mt-1 text-xs font-medium text-emerald-600">Uploaded ✓</p>
                  )}
                  {entry.status === 'failed' && (
                    <p role="alert" className="mt-1 text-xs font-medium text-red-600">{entry.error}</p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {entry.status === 'failed' && (
                    <Button
                      variant="ghost" size="sm" icon={IconArrowPath}
                      aria-label={`Retry uploading ${f.name}`}
                      onClick={() => patchEntry(entry.key, { status: 'selected', progress: 0, error: null })}
                    >Retry</Button>
                  )}
                  {entry.status === 'done' && api.remove ? (
                    <Button
                      variant="ghost" size="sm" icon={IconX}
                      aria-label={`Remove ${f.name}`}
                      loading={removeBusyKey === entry.key}
                      onClick={() => removeConfirmed(entry)}
                    >Remove</Button>
                  ) : entry.status !== 'uploading' && (
                    <Button
                      variant="ghost" size="sm" icon={IconX}
                      aria-label={`Remove ${f.name} from selection`}
                      onClick={() => removeFromQueue(entry)}
                    >Remove</Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* polite status — announced, never steals focus (spec AC) */}
      <p aria-live="polite" className="sr-only">
        {uploading ? 'Uploading files.' : ''}
        {!uploading && doneCount > 0 && failedCount === 0
          ? `${doneCount} file${doneCount === 1 ? '' : 's'} uploaded.` : ''}
        {!uploading && failedCount > 0 ? 'Some files could not be uploaded.' : ''}
      </p>
    </div>
  );
}
