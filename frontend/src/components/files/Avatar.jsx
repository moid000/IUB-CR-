import { useState } from 'react';
import { Button } from '../ui/Button.jsx';
import { IconCamera, IconX } from '../icons.jsx';
import { authApi } from '../../api/auth.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { friendlyUploadError } from '../../api/upload.js';
import { ACCEPT_AVATAR_ATTR, AVATAR_TYPES, MAX_AVATAR_BYTES, matchType, uploadToCloudinary } from '../../api/upload.js';

const SIZE_CLASS = {
  7: 'size-7 text-[10px]',
  9: 'size-9 text-xs',
  10: 'size-10 text-xs',
  12: 'size-12 text-sm',
  14: 'size-14 text-lg',
  20: 'size-20 text-2xl',
  24: 'size-24 text-3xl',
};

function initials(name) {
  return String(name ?? '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
}

/**
 * STEP 18 — avatar with automatic initials fallback. Renders the user's
 * profile image when set; on missing/broken image it falls back to
 * initials without layout shift (fixed square, object-cover).
 */
export function Avatar({ user, size = 9, rounded = 'rounded-full' }) {
  const [broken, setBroken] = useState(false);
  const url = user?.avatar?.url;
  const cls = SIZE_CLASS[size] ?? SIZE_CLASS[9];
  if (!url || broken) {
    return (
      <span className={`grid shrink-0 place-items-center bg-primary-600 font-semibold text-white ${cls} ${rounded}`} aria-hidden="true">
        {initials(user?.name)}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={`${user?.name ?? 'User'} — profile picture`}
      loading="lazy"
      onError={() => setBroken(true)}
      className={`shrink-0 ${cls} ${rounded} border border-white object-cover shadow-sm`}
    />
  );
}

/**
 * STEP 18 — self-service avatar editor (profile pages).
 * Flow: sign → browser-direct upload → confirm → refresh user. The server
 * derives folder/publicId/ownership from the session — the client never
 * sends a userId, folder or publicId. Images only, max 5 MB.
 */
export function AvatarEditor({ user, onChange = () => {} }) {
  const { refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);

  const upload = async (file) => {
    if (!file || busy) return;
    setError(null);
    setOk(null);
    if (!matchType(file, AVATAR_TYPES)) { setError("This file type isn't supported. Use PNG, JPG, JPEG or WEBP."); return; }
    if (file.size > MAX_AVATAR_BYTES) { setError('Profile picture must be 5 MB or smaller.'); return; }
    setBusy(true);
    setProgress(0);
    try {
      // 1 — server signs (namespace derived from OUR session, never client input)
      const sign = (await authApi.avatar.sign({
        file: { originalName: file.name, mimeType: file.type },
      }))?.data;
      // 2 — browser uploads DIRECTLY to Cloudinary
      const result = await uploadToCloudinary(sign, file, setProgress);
      // 3 — server verifies + associates the avatar with OUR account
      await authApi.avatar.confirm({ result });
      await refresh(); // update the auth context — layouts + profile react together
      setOk('Profile picture updated.');
      onChange?.();
    } catch (err) {
      setError(friendlyUploadError(err, 'Upload failed. Please try again.'));
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const remove = async () => {
    if (busy) return;
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      await authApi.avatar.remove();
      await refresh();
      setOk('Profile picture removed.');
      onChange?.();
    } catch (err) {
      setError(friendlyUploadError(err, "We couldn't remove the picture. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer?.files?.[0]);
  };

  return (
    <div className="flex items-center gap-4">
      <div
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-label="Change profile picture"
        aria-describedby="avatar-editor-status"
        onClick={() => !busy && document.getElementById('avatar-file-input')?.click()}
        onKeyDown={(e) => {
          if (!busy && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            document.getElementById('avatar-file-input')?.click();
          }
        }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`relative shrink-0 cursor-pointer rounded-2xl transition-transform hover:scale-[1.03] focus-visible:outline-2 focus-visible:outline-primary-500
          ${dragging ? 'ring-2 ring-primary-400' : ''}`}
      >
        <Avatar user={user} size={20} rounded="rounded-2xl" />
        <span className={`absolute -bottom-1 -right-1 grid place-items-center rounded-full border border-white bg-white p-1 ${busy ? 'text-slate-400' : 'text-slate-500'}`}>
          {busy ? (
            <svg className="size-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
            </svg>
          ) : (
            <IconCamera className="size-3.5" aria-hidden="true" />
          )}
        </span>
        <input
          id="avatar-file-input"
          type="file"
          accept={ACCEPT_AVATAR_ATTR}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          disabled={busy}
          onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }}
        />
      </div>

      <div className="min-w-0" id="avatar-editor-status" aria-live="polite">
        <p className="text-sm font-medium text-slate-700">Profile picture</p>
        <p className="text-xs text-slate-400">PNG, JPG, JPEG or WEBP — max 5 MB.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm" variant="secondary" disabled={busy}
            onClick={() => document.getElementById('avatar-file-input')?.click()}
          >{user?.avatar?.url ? 'Change photo' : 'Upload photo'}</Button>
          {user?.avatar?.url && (
            <Button size="sm" variant="ghost" icon={IconX} disabled={busy} onClick={remove}>Remove</Button>
          )}
        </div>
        {busy && (
          <div className="mt-2 max-w-48" role="status">
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${progress}%` }} />
            </div>
            <p className="mt-1 text-xs text-slate-500">{progress}%</p>
          </div>
        )}
        {error && <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">{error}</p>}
        {ok && !busy && <p className="mt-1.5 text-xs font-medium text-emerald-600">{ok}</p>}
      </div>
    </div>
  );
}
