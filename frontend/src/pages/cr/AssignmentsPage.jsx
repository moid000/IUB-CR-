import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { formatDateTime, timeAgo } from '../../admin/format.js';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, SearchInput, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Spinner } from '../../components/ui/Spinner.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconPlus, IconPencil, IconArchive, IconClipboard, IconArrowRight, IconPaperclip } from '../../components/icons.jsx';
import { FileList, FileChips } from '../../components/files/FileList.jsx';
import { AttachModal } from '../../components/files/AttachModal.jsx';

/** datetime-local default: tomorrow 23:59 in Pakistan time, value for <input> */
function defaultDeadline() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T23:59`;
}

/**
 * CR assignments — created in the CR's OWN section with a subject from the
 * same section (active only). Deadline is sent as ISO-8601 (stored UTC).
 */
function AssignmentForm({ open, onClose, initial, subjects, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [subject, setSubject] = useState(initial?.subject?._id ?? initial?.subject ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [deadline, setDeadline] = useState(
    isEdit && initial?.deadline
      ? new Date(initial.deadline).toISOString().slice(0, 16)
      : defaultDeadline()
  );
  const [errors, setErrors] = useState({});

  const activeSubjects = useMemo(() => subjects.filter((s) => s.status === 'active'), [subjects]);

  const submit = async () => {
    const next = {};
    if (title.trim().length < 2) next.title = 'Give the assignment a title.';
    if (!subject) next.subject = 'Select a subject.';
    if (!deadline) next.deadline = 'Set a deadline.';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = {
      title: title.trim(),
      subject,
      deadline: new Date(deadline).toISOString(), // backend stores UTC
    };
    if (instructions.trim()) body.instructions = instructions.trim();

    let created = null;
    if (isEdit) await crApi.assignments.update(initial._id, body);
    else created = (await crApi.assignments.create(body))?.data;
    onSaved(isEdit ? 'Assignment updated.' : 'Assignment created.', created);
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit assignment' : 'New assignment'} submitLabel={isEdit ? 'Save changes' : 'Create assignment'} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          <Input label="Title" required id="asg-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Lab 3 — linked list" error={errors.title ?? fieldErrors?.title ?? null} />
          <Select label="Subject" required id="asg-subject" value={subject} onChange={(e) => setSubject(e.target.value)} error={errors.subject ?? fieldErrors?.subject ?? null}>
            <option value="">Select subject…</option>
            {activeSubjects.map((s) => <option key={s._id} value={s._id}>{s.code} — {s.name}</option>)}
            {activeSubjects.length === 0 && <option value="" disabled>No active subjects — create a subject first.</option>}
          </Select>
          <Input
            label="Deadline" required id="asg-deadline" type="datetime-local"
            value={deadline} onChange={(e) => setDeadline(e.target.value)}
            hint="Shown to students in Pakistan time (PKT)." error={errors.deadline ?? fieldErrors?.deadline ?? null}
          />
          <div>
            <label htmlFor="asg-instructions" className="mb-1.5 block text-sm font-medium text-slate-700">Instructions (optional)</label>
            <textarea
              id="asg-instructions" rows="4" value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              className="block w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-300 focus:border-primary-500"
              placeholder="What should students submit, and how?"
            />
            {fieldErrors?.instructions && <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">{fieldErrors.instructions}</p>}
          </div>
        </>
      )}
    </FormModal>
  );
}

/** Submissions overview — students of the CR's OWN section only. */
function SubmissionsModal({ open, onClose, assignment }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !assignment?._id) return undefined;
    let cancelled = false;
    setItems(null);
    setError(null);
    crApi.assignments.submissions(assignment._id, { limit: 100 })
      .then((res) => { if (!cancelled) setItems(res?.data ?? []); })
      .catch((err) => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [open, assignment]);

  return (
    <Modal open={open} onClose={onClose} title={`Submissions — ${assignment?.title ?? ''}`} className="max-w-lg">
      {error ? (
        <Alert variant="danger">{error.message}</Alert>
      ) : items === null ? (
        <div className="grid place-items-center py-8" role="status" aria-label="Loading submissions"><Spinner className="size-6 text-primary-500" /></div>
      ) : items.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">No submissions yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((s) => (
            <li key={s._id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">{s.student?.name ?? '—'}</p>
                <p className="text-xs text-slate-500">{s.student?.rollNo} · {formatDateTime(s.submittedAt)} <FileChips files={s.files} /></p>
                {(s.files?.length ?? 0) > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs font-medium text-primary-600 hover:text-primary-700">View files</summary>
                    <div className="mt-1.5"><FileList files={s.files} /></div>
                  </details>
                )}
              </div>
              {s.isLate
                ? <Badge variant="danger">Late</Badge>
                : <Badge variant="success">On time</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export default function AssignmentsPage() {
  const { user } = useAuth();
  const section = user?.section;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [status, setStatus] = useState('published');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null);
  const [attachItem, setAttachItem] = useState(null); // attachment manager target (separate state — no close race)
  const [submissionsFor, setSubmissionsFor] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items: subjects } = useAdminQuery(() => crApi.subjects.list({ status: 'active', limit: 100 }), []);
  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => crApi.assignments.list({
      search: debouncedSearch || undefined,
      subjectId: subjectFilter !== 'all' ? subjectFilter : undefined,
      status: status !== 'all' ? status : undefined,
      page, limit: 10,
    }),
    [debouncedSearch, subjectFilter, status, page]
  );

  const [lastKey, setLastKey] = useState('');
  const key = `${debouncedSearch}|${subjectFilter}|${status}`;
  if (key !== lastKey) { setLastKey(key); setPage(1); }

  if (!section) return <NoSection />;

  const confirmArchive = async () => {
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      await crApi.assignments.archive(archiveTarget._id);
      setArchiveTarget(null);
      reload();
      showFlash('Assignment archived.');
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Assignments" description="Tasks and deadlines for your section.">
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New assignment</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search assignments…" label="Search assignments" />
        <FilterSelect label="Subject" value={subjectFilter} onChange={setSubjectFilter}>
          <option value="all">All subjects</option>
          {subjects.map((s) => <option key={s._id} value={s._id}>{s.code}</option>)}
        </FilterSelect>
        <FilterSelect label="Status" value={status} onChange={setStatus}>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </FilterSelect>
      </FilterBar>

      {error ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft">
          <p className="text-sm font-medium text-red-600">{error.message}</p>
          <div className="mt-3"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </div>
      ) : loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-100" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft">
          <div className="flex flex-col items-center py-10 text-center">
            <IconClipboard className="size-10 text-slate-300" />
            <h3 className="mt-3 text-sm font-semibold text-slate-700">No assignments created yet.</h3>
            <p className="mt-1 max-w-sm text-sm text-slate-500">Create the first task — students see it with its deadline and can submit.</p>
            <div className="mt-5"><Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New assignment</Button></div>
          </div>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a._id} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft transition-shadow hover:shadow-lift">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">{a.title}</p>
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="mt-1 text-sm text-slate-500">{a.subject?.name ?? '—'}{a.subject?.code ? ` (${a.subject.code})` : ''}</p>
                  <p className={`mt-2 text-xs font-medium ${a.deadlinePassed ? 'text-red-600' : 'text-slate-600'}`}>
                    {a.deadlinePassed ? 'Deadline passed' : 'Due'} · {formatDateTime(a.deadline)} PKT
                  </p>
                  {a.instructions && <p className="mt-2 line-clamp-2 text-sm text-slate-500">{a.instructions}</p>}
                  <p className="mt-2 flex items-center gap-2 text-xs text-slate-400"><FileChips files={a.attachments} /></p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setSubmissionsFor(a)}>Submissions</Button>
                  {a.status === 'published' && (
                    <>
                      <Button variant="ghost" size="sm" icon={IconPaperclip} onClick={() => setAttachItem(a)}>Files</Button>
                      <Button variant="ghost" size="sm" icon={IconPencil} onClick={() => setModal({ mode: 'edit', item: a })}>Edit</Button>
                      <Button variant="ghost" size="sm" icon={IconArchive} className="text-slate-500 hover:text-red-600" onClick={() => { setArchiveTarget(a); setArchiveError(null); }}>Archive</Button>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <span>Page {pagination.page} of {pagination.totalPages}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="secondary" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      {modal && (
        <AssignmentForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.item : null}
          subjects={subjects}
          onSaved={(msg, created) => {
            showFlash(msg);
            reload();
            if (modal.mode === 'create' && created?._id) setAttachItem(created); // polished flow: straight to attachments
          }}
        />
      )}

      {attachItem && (
        <AttachModal
          open
          onClose={() => { setAttachItem(null); reload(); }}
          parentType="assignment"
          parentLabel="assignment"
          fetchItem={async () => (await crApi.assignments.get(attachItem._id))?.data}
          api={crApi.files}
          onDone={reload}
        />
      )}

      <SubmissionsModal open={Boolean(submissionsFor)} onClose={() => setSubmissionsFor(null)} assignment={submissionsFor} />

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Archive assignment?"
        body={<p><span className="font-medium">{archiveTarget?.title}</span> will be closed for submissions and hidden from your section.</p>}
        confirmLabel="Archive assignment"
        onConfirm={confirmArchive}
        busy={archiveBusy}
        error={archiveError}
        danger
      />
    </div>
  );
}
