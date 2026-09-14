import { useEffect, useState } from 'react';
import { studentApi } from '../../api/student.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { formatDateTime, timeAgo } from '../../admin/format.js';
import { PageHeader, FilterBar, SuccessFlash } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { Spinner } from '../../components/ui/Spinner.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import { IconClipboard, IconFileText } from '../../components/icons.jsx';

const FILTERS = ['All', 'Pending', 'Submitted', 'Overdue'];

function submissionState(a) {
  // Server-authoritative: mySubmission + deadlinePassed come from the backend.
  if (a.mySubmission) return 'submitted';
  return a.deadlinePassed ? 'overdue' : 'pending';
}

/** Assignments for the student's OWN section + their single submission each. */
export default function StudentAssignmentsPage() {
  const { user } = useAuth();
  const section = user?.section;
  const [filter, setFilter] = useState('All');
  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.assignments.list({ status: 'published', page: 1, limit: 30 }),
    []
  );
  const [openId, setOpenId] = useState(null);
  const [flash, showFlash] = useFlash();

  if (!section) return <NoSection />;

  const filtered = filter === 'All'
    ? items
    : items.filter((a) => (filter === 'Submitted' ? submissionState(a) === 'submitted'
        : filter === 'Pending' ? submissionState(a) === 'pending'
        : submissionState(a) === 'overdue'));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Assignments"
        description={`Published for Section ${section.name}. Submit before the deadline.`}
      />
      <SuccessFlash message={flash} />

      <FilterBar>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Assignment filters">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`h-8 rounded-lg px-3 text-xs font-medium transition-colors
                ${filter === f ? 'bg-primary-600 text-white shadow-sm' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </FilterBar>

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <div className="space-y-3" role="status" aria-label="Loading assignments">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl border border-slate-200/60 bg-slate-100/60" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconClipboard className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">
            {items.length === 0 ? 'No assignments available.' : `No ${filter.toLowerCase()} assignments.`}
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            {items.length === 0 ? 'When your CR publishes an assignment it will appear here.' : 'Try a different filter.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((a) => {
            const state = submissionState(a);
            return (
              <li key={a._id}>
                <button
                  type="button"
                  onClick={() => { setOpenId(a._id); showFlash(null); }}
                  className="w-full rounded-2xl border border-slate-200/80 bg-white p-5 text-left shadow-soft transition-shadow hover:shadow-lift"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900">{a.title}</h3>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {a.subject?.name ?? ''}{a.subject?.name ? ' · ' : ''}Due {formatDateTime(a.deadline)}
                      </p>
                    </div>
                    {state === 'submitted'
                      ? <Badge variant="success">Submitted{a.mySubmission?.isLate ? ' (late)' : ''}</Badge>
                      : state === 'overdue'
                        ? <Badge variant="danger">Overdue</Badge>
                        : <Badge variant="warning">Pending</Badge>}
                  </div>
                  {a.instructions && <p className="mt-1.5 line-clamp-2 text-sm text-slate-600">{a.instructions}</p>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {openId && (
        <AssignmentDetail
          assignmentId={openId}
          onClose={() => { setOpenId(null); reload(); }}
          onSaved={(msg) => showFlash(msg)}
        />
      )}
    </div>
  );
}

/* ---------------------- assignment detail + submission ---------------------- */

function AssignmentDetail({ assignmentId, onClose, onSaved }) {
  const [assignment, setAssignment] = useState(null);
  const [submission, setSubmission] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [textAnswer, setTextAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [uploading, setUploading] = useState(null); // { name, progress }
  const [uploadError, setUploadError] = useState(null);
  const [maxBytes, setMaxBytes] = useState(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await studentApi.assignments.get(assignmentId);
      const a = res?.data ?? null;
      setAssignment(a);
      let sub = null;
      try { sub = (await studentApi.assignments.submission(assignmentId))?.data ?? null; } catch { sub = null; }
      setSubmission(sub);
      setTextAnswer(sub?.textAnswer ?? '');
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [assignmentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = !assignment || assignment.status === 'archived' || assignment.deadlinePassed;

  const submit = async (e) => {
    e.preventDefault();
    setSaveError(null);
    const hasPriorFiles = (submission?.files?.length ?? 0) > 0;
    if (!textAnswer.trim() && !hasPriorFiles) {
      setSaveError('Write your answer, or attach a file after your first submission.');
      return;
    }
    setSaving(true);
    try {
      const isNew = !submission;
      await studentApi.assignments.submit(assignmentId, { textAnswer: textAnswer.trim() || null });
      const sub = (await studentApi.assignments.submission(assignmentId))?.data ?? null;
      setSubmission(sub);
      onSaved(isNew ? 'Assignment submitted.' : 'Submission updated.');
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const attachFile = async (file) => {
    if (!file) return;
    setUploadError(null);
    setUploading({ name: file.name, progress: 0 });
    try {
      // Step 1 — server signs the upload (own submission + deadline enforced)
      const sign = await studentApi.files.sign({
        parentType: 'submission',
        parentId: submission._id,
        file: { originalName: file.name, mimeType: file.type },
      }).then((r) => { const d = r?.data ?? null; if (d?.maxSizeBytes) setMaxBytes(d.maxSizeBytes); return d; });

      // Step 2 — browser uploads DIRECTLY to Cloudinary (signed, scoped namespace)
      const cloudResult = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', sign.uploadUrl);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setUploading({ name: file.name, progress: Math.round((ev.loaded / ev.total) * 100) });
        };
        xhr.onload = () => {
          try {
            const body = JSON.parse(xhr.responseText);
            xhr.status >= 200 && xhr.status < 300 ? resolve(body) : reject(new Error(body?.error?.message ?? 'Upload failed'));
          } catch { reject(new Error('Upload failed')); }
        };
        xhr.onerror = () => reject(new Error('Upload failed'));
        const fd = new FormData();
        fd.append('api_key', sign.apiKey);
        fd.append('timestamp', sign.timestamp);
        fd.append('signature', sign.signature);
        fd.append('folder', sign.folder);
        fd.append('public_id', sign.publicId);
        fd.append('file', file);
        xhr.send(fd);
      });

      // Step 3 — server verifies + attaches the metadata (idempotent)
      await studentApi.files.confirm({
        parentType: 'submission',
        parentId: submission._id,
        result: cloudResult,
      });
      const sub = (await studentApi.assignments.submission(assignmentId))?.data ?? null;
      setSubmission(sub);
      onSaved('File attached to your submission.');
    } catch (err) {
      setUploadError(err instanceof Error ? err : err?.message ? err : new Error('Upload failed'));
    } finally {
      setUploading(null);
    }
  };

  return (
    <Modal open onClose={onClose} title="Assignment" className="sm:max-w-2xl">
      {loading ? (
        <div className="flex items-center justify-center py-12" role="status"><Spinner /></div>
      ) : loadError ? (
        <Alert variant="danger"><p className="font-medium">{loadError.message}</p></Alert>
      ) : assignment ? (
        <div className="space-y-4">
          {/* ---- header ---- */}
          <div>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-lg font-semibold tracking-tight text-slate-900">{assignment.title}</h3>
              {locked
                ? <Badge variant="danger">Closed</Badge>
                : <Badge variant="success">Open</Badge>}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {assignment.subject?.name ?? ''}
              {assignment.subject?.name ? ' · ' : ''}Due {formatDateTime(assignment.deadline)}
            </p>
          </div>

          {assignment.instructions && (
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-4">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{assignment.instructions}</p>
            </div>
          )}

          {(assignment.attachments?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Assignment files</p>
              <ul className="mt-2 space-y-1.5">
                {assignment.attachments.map((f) => (
                  <li key={f._id ?? f.publicId}>
                    <a href={f.url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700 hover:underline">
                      <IconFileText className="size-4" />{f.originalName ?? 'Attachment'}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ---- current submission ---- */}
          {submission ? (
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-emerald-800">
                  Submitted {timeAgo(submission.submittedAt)}
                </p>
                {submission.isLate && <Badge variant="warning">Late</Badge>}
              </div>
              {(submission.files?.length ?? 0) > 0 && (
                <ul className="mt-2 space-y-1">
                  {submission.files.map((f) => (
                    <li key={f._id ?? f.publicId}>
                      <a href={f.url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700 hover:underline">
                        <IconFileText className="size-4" />{f.originalName ?? 'Attachment'}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="rounded-xl border border-amber-100 bg-amber-50/60 px-4 py-3 text-sm text-amber-800">
              Not submitted yet.
            </p>
          )}

          {/* ---- submission form ---- */}
          {locked ? (
            <p className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              {assignment.status === 'archived'
                ? 'This assignment is archived — submissions are closed.'
                : 'The deadline has passed — submissions are closed.'}
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-3 border-t border-slate-100 pt-4">
              <div>
                <label htmlFor="submission-answer" className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {submission ? 'Update your answer' : 'Your answer'}
                </label>
                <textarea
                  id="submission-answer"
                  rows={4}
                  value={textAnswer}
                  onChange={(e) => setTextAnswer(e.target.value)}
                  placeholder="Type your answer here…"
                  className="mt-1.5 w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  aria-describedby={saveError ? 'submission-error' : undefined}
                />
              </div>

              {submission && (
                <div>
                  <label htmlFor="submission-file" className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Attach file (PDF, images, documents){maxBytes ? ` — max ${Math.ceil(maxBytes / 1048576)} MB` : ''}
                  </label>
                  <input
                    id="submission-file"
                    type="file"
                    className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-primary-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-700"
                    disabled={uploading != null}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) attachFile(f);
                    }}
                    aria-describedby={uploadError ? 'upload-error' : undefined}
                  />
                  {uploading && (
                    <div className="mt-2" role="status">
                      <p className="text-xs text-slate-500">Uploading {uploading.name}… {uploading.progress}%</p>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${uploading.progress}%` }} />
                      </div>
                    </div>
                  )}
                  {uploadError && (
                    <p id="upload-error" role="alert" className="mt-2 text-xs text-red-600">
                      {uploadError.message} — the file was NOT attached.
                    </p>
                  )}
                </div>
              )}

              {saveError && (
                <p id="submission-error" role="alert" className="text-xs text-red-600">{saveError.message}</p>
              )}

              <div className="flex items-center gap-2.5">
                <Button type="submit" loading={saving}>
                  {submission ? 'Update submission' : 'Submit'}
                </Button>
                {submission && (
                  <span className="text-xs text-slate-400">Resubmission is allowed until the deadline.</span>
                )}
              </div>
            </form>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
