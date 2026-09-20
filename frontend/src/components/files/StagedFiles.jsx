import { useRef, useState } from 'react';
import { Button } from '../ui/Button.jsx';
import { IconPaperclip, IconX } from '../icons.jsx';
import { ACCEPT_ATTR, MAX_FILE_BYTES, formatBytes, matchType } from '../../api/upload.js';

/**
 * Create-modal file STAGING (2026-09-20, owner request): the CR picks files
 * BEFORE the post exists. Nothing uploads here — the modal's submit runs
 * create → sign/upload/confirm each file → ONE combined group broadcast so
 * the class group receives the text AND all media together (no premature
 * text-then-file double sends). Files already attached AFTER publishing can
 * still be managed via AttachModal as before.
 */
export function StagedFiles({ files = [], onAdd, onRemove, maxFiles = 10, disabled = false }) {
  const inputRef = useRef(null);
  const [notice, setNotice] = useState(null);

  const add = (list) => {
    if (disabled) return;
    const accepted = [];
    let msg = null;
    for (const f of list) {
      if (!matchType(f)) { msg = "This file type isn't supported."; continue; }
      if (f.size > MAX_FILE_BYTES) { msg = 'File must be 10 MB or smaller.'; continue; }
      if (files.length + accepted.length + 1 > maxFiles) { msg = `You can attach up to ${maxFiles} files.`; continue; }
      accepted.push(f);
    }
    setNotice(msg);
    if (accepted.length) onAdd(accepted);
  };

  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-3">
      <input
        ref={inputRef} type="file" multiple accept={ACCEPT_ATTR} className="hidden"
        onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ''; }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button" variant="secondary" size="sm" icon={IconPaperclip}
          disabled={disabled || files.length >= maxFiles}
          onClick={() => inputRef.current?.click()}
        >
          Attach files
        </Button>
        <span className="text-xs text-slate-400">
          Optional — files go to your WhatsApp group together with this post
        </span>
      </div>
      {notice && <p className="mt-2 text-xs text-rose-500">{notice}</p>}
      {files.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${f.size}-${i}`}
              className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-1.5 text-sm shadow-sm"
            >
              <span className="min-w-0 truncate text-slate-700">{f.name}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                {formatBytes(f.size)}
                <button
                  type="button" onClick={() => onRemove(i)} aria-label={`Remove ${f.name}`}
                  className="rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <IconX className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
