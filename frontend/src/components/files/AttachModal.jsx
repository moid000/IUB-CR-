import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Spinner } from '../ui/Spinner.jsx';
import { Alert } from '../ui/Alert.jsx';
import { FileUploader } from './FileUploader.jsx';
import { FileList } from './FileList.jsx';
import { IconPaperclip } from '../icons.jsx';

/**
 * STEP 18 — shared "manage attachments" modal for CR content (announcements,
 * notes, assignments). Fetches the parent fresh so the confirmed list always
 * comes from the server; the uploader runs the secure sign→upload→confirm
 * flow against that parent. Reused across pages — upload logic lives ONLY
 * in FileUploader (spec E).
 */
export function AttachModal({
  open,
  onClose,
  parentType,
  parentLabel = 'item',
  fetchItem, // async () => parent doc (must include attachments[])
  api, // { sign, confirm, remove }
  onDone = () => {},
}) {
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const [removeError, setRemoveError] = useState(null);

  const load = async () => {
    setError(null);
    /* STEP 18 fix: on refresh (after attach/remove) we already have `item` —
       do NOT flip to the spinner, that would unmount FileUploader and destroy
       in-flight upload state (progress/success/retry feedback). */
    if (!item) setLoading(true);
    try {
      setItem((await fetchItem()) ?? null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Remove an already-confirmed attachment (server-side, audited). */
  const removeFile = async (f) => {
    if (!api?.remove || !item?._id || !f.publicId) return;
    setRemovingId(f._id ?? f.publicId);
    setRemoveError(null);
    try {
      await api.remove({ parentType, parentId: item._id, publicId: f.publicId });
      load();
      onDone();
    } catch (err) {
      setRemoveError(err?.message ?? 'We could not remove this file. Please try again.');
    } finally {
      setRemovingId(null);
    }
  };

  const files = item?.attachments ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Manage attachments"
      className="sm:max-w-xl"
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}
    >
      {(loading && !item) ? (
        <div className="flex items-center justify-center py-10" role="status"><Spinner /></div>
      ) : error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={load}>Try again</Button></div>
        </Alert>
      ) : (
        <div className="space-y-4">
          <p className="text-sm font-semibold tracking-tight text-slate-900">
            <IconPaperclip className="mr-1 inline size-4 text-primary-500" aria-hidden="true" />
            {item?.title ?? parentLabel}
          </p>
          {files.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Current files</p>
              <div className="mt-2">
                <FileList files={files} onRemove={api?.remove ? removeFile : null} removeBusyId={removingId} />
              </div>
            </div>
          )}
          {removeError && <Alert variant="danger"><p className="text-sm font-medium">{removeError}</p></Alert>}
          {files.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-3 text-sm text-slate-500">
              No files attached yet — add images, PDFs or documents below.
            </p>
          )}
          <FileUploader
            parentType={parentType}
            parentId={item?._id}
            api={api}
            existing={files}
            onAttached={() => { load(); onDone(); }}
            onRemoved={() => { load(); onDone(); }}
          />
        </div>
      )}
    </Modal>
  );
}
