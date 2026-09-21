import useFocusHighlight from '../../hooks/useFocusHighlight.js';
import { useEffect, useState } from 'react';
import { Skeleton, SkeletonText } from '../../components/ui/Skeleton.jsx';
import { studentApi } from '../../api/student.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { formatDateTime, timeAgo } from '../../admin/format.js';
import { PageHeader, FilterBar, SuccessFlash } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import { IconClipboard } from '../../components/icons.jsx';
import { Stagger, StaggerItem, PillFilters } from '../../components/motion/primitives.jsx';
import { DueChip } from '../../components/shared/OverviewBits.jsx';
import { FileUploader } from '../../components/files/FileUploader.jsx';
import { FileList } from '../../components/files/FileList.jsx';
import {
  ACCEPT_ATTR, MAX_FILE_BYTES, formatBytes, matchType, uploadToCloudinary,
} from '../../api/upload.js';

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
    [],
    () => studentApi.assignments.cachedList({ status: 'published', page: 1, limit: 30 })
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
        <PillFilters options={FILTERS} value={filter} onChange={setFilter} groupId="student-assignments" label="Assignment filters" />
      </FilterBar>

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <div className="space-y-3" role="status" aria-label="Loading assignments">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 skeleton-shimmer rounded-2xl border border-slate-200/60" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconClipboard className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">
            {items.length === 0 ? 'No assignments available.' : `No ${filter.toLowerCase()} assignments.`}
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            {items.length === 0 ? 'When your CR or GR publishes an assignment it will appear here.' : 'Try a different filter.'}
          </p>
        </div>
      ) : (
        <Stagger className="space-y-3" role="list" aria-label="Assignments">
          {filtered.map((a) => {
            const state = submissionState(a);
            return (
              <StaggerItem key={a._id} role="listitem">
                <button
                  type="button"
                  data-item-id={a._id}
                  onClick={() => { setOpenId(a._id); showFlash(null); }}
                  className={`group block w-full rounded-2xl border p-4 text-left shadow-soft transition-all duration-200
                    hover:-translate-y-0.5 hover:shadow-lift [@media(hover:hover)]:active:scale-[0.99]
                    ${state === 'submitted'
                      ? 'border-emerald-200/80 bg-gradient-to-br from-emerald-50/50 via-white to-white'
                      : state === 'overdue'
                        ? 'border-red-200/80 bg-gradient-to-br from-red-50/50 via-white to-white'
                        : 'border-slate-200/80 bg-white'}`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`grid size-10 shrink-0 place-items-center rounded-xl ring-1
                      ${state === 'submitted'
                        ? 'bg-emerald-100 text-emerald-700 ring-emerald-200'
                        : state === 'overdue'
                          ? 'bg-red-100 text-red-700 ring-red-200'
                          : 'bg-primary-50 text-primary-600 ring-primary-100'}`}>
                      <IconClipboard className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="min-w-0 text-sm font-semibold text-slate-900 transition-colors group-hover:text-primary-700">{a.title}</h3>
                        {state === 'submitted'
                          ? <Badge variant="success">Submitted{a.mySubmission?.isLate ? ' (late)' : ''}</Badge>
                          : state === 'overdue'
                            ? <Badge variant="danger">Overdue</Badge>
                            : <DueChip deadline={a.deadline} passed={a.deadlinePassed} />}
                      </div>
                      <p className="mt-1 truncate text-xs font-medium text-slate-500">
                        {a.subject?.name ?? 'General'} · Due {formatDateTime(a.deadline)}
                      </p>
                      {a.instructions && <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-slate-500">{a.instructions}</p>}
                    </div>
                  </div>
                </button>
              </StaggerItem>
            );
          })}
        </Stagger>
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
  const [pending, setPending] = useState([]); // files chosen BEFORE the first submit
  const [removingFileId, setRemovingFileId] = useState(null);
  const [pendingNotice, setPendingNotice] = useState(null);
  const [afterUpload, setAfterUpload] = useState(null); // { done, failed } summary

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

  useFocusHighlight(filtered);

  useEffect(() => { load(); }, [assignmentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = !assignment || assignment.status === 'archived' || assignment.deadlinePassed;

  const submit = async (e) => {
    e.preventDefault();
    setSaveError(null);
    const hasPriorFiles = (submission?.files?.length ?? 0) > 0;
    const files = [...pending]; // snapshot
    if (!textAnswer.trim() && !hasPriorFiles && files.length === 0) {
      setSaveError('Write your answer, or attach at least one file.');
      return;
    }
    setSaving(true);
    setAfterUpload(null);
    try {
      const isNew = !submission;
      await studentApi.assignments.submit(assignmentId, {
        textAnswer: textAnswer.trim() || null,
        // server accepts a file-only FIRST submission when we declare intent
        ...(isNew && !textAnswer.trim() && files.length > 0 ? { pendingFiles: files.length } : {}),
      });
      let sub = (await studentApi.assignments.submission(assignmentId))?.data ?? null;
      setSubmission(sub);

      // The flow completes now: selected files upload against the fresh submission.
      if (isNew && files.length > 0 && sub?._id) {
        const failures = [];
        for (const f of files) {
          try { await uploadOne(sub._id, f); } catch { failures.push(f); }
        }
        setPending(failures);
        sub = (await studentApi.assignments.submission(assignmentId))?.data ?? null;
        setSubmission(sub);
        const doneCount = files.length - failures.length;
        setAfterUpload({ done: doneCount, failed: failures.length });
        if (failures.length === 0) onSaved(`Assignment submitted with ${files.length} file${files.length === 1 ? '' : 's'}.`);
        else onSaved('Assignment submitted — some files could not be attached.');
      } else {
        onSaved(isNew ? 'Assignment submitted.' : 'Submission updated.');
      }
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const refreshSubmission = async () => {
    try { setSubmission((await studentApi.assignments.submission(assignmentId))?.data ?? null); } catch { /* keep previous */ }
  };

  /* Remove a confirmed submission file (server-side, audited). */
  const removeSubmissionFile = async (f) => {
    if (!submission?._id || !f.publicId) return;
    setRemovingFileId(f._id ?? f.publicId);
    setSaveError(null);
    try {
      await studentApi.files.remove({ parentType: 'submission', parentId: submission._id, publicId: f.publicId });
      refreshSubmission();
    } catch (err) {
      setSaveError(err);
    } finally {
      setRemovingFileId(null);
    }
  };


  /* Files picked before the very first submit — client-side mirror of the
     server allowlist; uploads only happen once a submission exists. */
  const addPending = (fileList) => {
    const files = [...fileList];
    let notice = null;
    for (const f of files) {
      if (!matchType(f)) { notice = "This file type isn't supported."; continue; }
      if (f.size > MAX_FILE_BYTES) { notice = 'File must be 10 MB or smaller.'; continue; }
      if (pending.length + 1 > 10) { notice = 'You can attach up to 10 files.'; continue; }
      setPending((p) => [...p, f]);
    }
    setPendingNotice(notice);
  };

  /* Sign → direct Cloudinary upload → confirm, against the now-existing submission. */
  const uploadOne = async (parentId, file) => {
    const sign = (await studentApi.files.sign({
      parentType: 'submission', parentId,
      file: { originalName: file.name, mimeType: file.type },
    }))?.data;
    const result = await uploadToCloudinary(sign, file);
    await studentApi.files.confirm({ parentType: 'submission', parentId, result });
  };

  return (
    <Modal open onClose={onClose} title="Assignment" className="sm:max-w-2xl">
      {loading ? (
        <div className="space-y-4" role="status"><Skeleton className="h-6 w-3/4 rounded" /><SkeletonText lines={5} /></div>
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
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Assignment files from your CR / GR</p>
              <div className="mt-2"><FileList files={assignment.attachments} /></div>
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
                <div className="mt-2">
                  <FileList
                    files={submission.files}
                    onRemove={studentApi.files?.remove ? removeSubmissionFile : null}
                    removeBusyId={removingFileId}
                  />
                </div>
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
                  className="mt-1.5 w-full resize-y rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 transition-colors hover:border-slate-300 focus:border-primary-500"
                  aria-describedby={saveError ? 'submission-error' : undefined}
                />
              </div>

              {submission ? (
                <FileUploader
                  parentType="submission"
                  parentId={submission._id}
                  api={studentApi.files}
                  existing={submission.files ?? []}
                  label="Attach files to your submission"
                  onAttached={refreshSubmission}
                  onRemoved={refreshSubmission}
                />
              ) : (
                <div>
                  <label htmlFor="pending-files" className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Files — they upload right after you submit
                  </label>
                  <input
                    id="pending-files" type="file" multiple accept={ACCEPT_ATTR}
                    className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-primary-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-700"
                    onChange={(e) => { addPending(e.target.files ?? []); e.target.value = ''; }}
                  />
                  {pendingNotice && (
                    <p role="alert" className="mt-1.5 text-xs text-red-600">{pendingNotice}</p>
                  )}
                  {pending.length > 0 && (
                    <ul className="mt-2 space-y-1.5" aria-label="Files waiting to upload">
                      {pending.map((f, i) => (
                        <li key={`${f.name}-${f.size}-${i}`} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
                          <span className="min-w-0 truncate text-sm text-slate-700">
                            {f.name} <span className="text-xs text-slate-400">({formatBytes(f.size)})</span>
                          </span>
                          <Button type="button" variant="ghost" size="sm"
                            aria-label={`Remove ${f.name} from selection`}
                            onClick={() => setPending((p) => p.filter((_, idx) => idx !== i))}>Remove</Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {afterUpload && (
                <p role="status" className={`text-xs font-medium ${afterUpload.failed ? 'text-red-600' : 'text-emerald-600'}`}>
                  {afterUpload.failed > 0
                    ? `${afterUpload.failed} file${afterUpload.failed === 1 ? '' : 's'} could not be attached — retry below.`
                    : `${afterUpload.done} file${afterUpload.done === 1 ? '' : 's'} attached.`}
                </p>
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
