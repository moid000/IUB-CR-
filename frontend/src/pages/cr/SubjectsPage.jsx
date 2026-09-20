import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, SearchInput, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Textarea } from '../../components/ui/Textarea.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconPlus, IconPencil, IconArchive, IconTrash, IconBook } from '../../components/icons.jsx';
import { Stagger, StaggerItem } from '../../components/motion/primitives.jsx';

const CODE_RE = /^[A-Z0-9-]{2,12}$/;

/**
 * CR subjects — the section is ALWAYS server-derived from the authenticated
 * CR; the form never sends a section field.
 */
function SubjectForm({ open, onClose, initial, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [teacherName, setTeacherName] = useState(initial?.teacherName ?? '');
  const [creditHours, setCreditHours] = useState(initial?.creditHours != null ? String(initial.creditHours) : '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [errors, setErrors] = useState({});

  const submit = async () => {
    const next = {};
    if (name.trim().length < 2) next.name = 'Enter the subject name.';
    if (!CODE_RE.test(code.trim().toUpperCase())) next.code = 'Code must be 2–12 letters, digits or dashes.';
    if (creditHours && (!Number.isInteger(Number(creditHours)) || Number(creditHours) < 1)) {
      next.creditHours = 'Credit hours must be a whole number of at least 1.';
    }
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = { name: name.trim(), code: code.trim().toUpperCase() };
    if (teacherName.trim()) body.teacherName = teacherName.trim();
    if (creditHours) body.creditHours = Number(creditHours);
    if (description.trim()) body.description = description.trim();

    if (isEdit) await crApi.subjects.update(initial._id, body);
    else await crApi.subjects.create(body);
    onSaved(isEdit ? 'Subject updated.' : 'Subject created.');
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit subject' : 'New subject'} submitLabel={isEdit ? 'Save changes' : 'Create subject'} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          {isEdit && (
            <Alert variant="info">
              Codes are unique within your section. Archived subjects cannot be modified.
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Subject name" required id="cr-subject-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Data Structures" error={errors.name ?? fieldErrors?.name ?? null} />
            <Input label="Code" required id="cr-subject-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="CS-201" hint="2–12 letters, digits or dashes — stored uppercase." error={errors.code ?? fieldErrors?.code ?? null} />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Teacher (optional)" id="cr-subject-teacher" value={teacherName} onChange={(e) => setTeacherName(e.target.value)} placeholder="Dr. Ahmed" error={fieldErrors?.teacherName ?? null} />
            <Input label="Credit hours (optional)" id="cr-subject-credits" type="number" min="1" step="1" value={creditHours} onChange={(e) => setCreditHours(e.target.value)} error={errors.creditHours ?? fieldErrors?.creditHours ?? null} />
          </div>
          <Textarea id="cr-subject-description" rows={3} label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} error={fieldErrors?.description} placeholder="Brief outline of the subject…" />
        </>
      )}
    </FormModal>
  );
}

export default function SubjectsPage() {
  const { user } = useAuth();
  const section = user?.section;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => crApi.subjects.list({
      search: debouncedSearch || undefined,
      status: status !== 'all' ? status : undefined,
      page, limit: 20,
    }),
    [debouncedSearch, status, page],
    () => crApi.subjects.cachedList({
      search: debouncedSearch || undefined,
      status: status !== 'all' ? status : undefined,
      page, limit: 20,
    })
  );

  // Reset to page 1 when filters change
  const [lastKey, setLastKey] = useState('');
  const key = `${debouncedSearch}|${status}`;
  if (key !== lastKey) { setLastKey(key); setPage(1); }

  if (!section) return <NoSection />;

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await crApi.subjects.delete(deleteTarget._id);
      setDeleteTarget(null);
      reload();
      showFlash('Subject deleted permanently.');
    } catch (err) {
      setDeleteError(err);
    } finally {
      setDeleteBusy(false);
    }
  };

  const confirmArchive = async () => {
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      await crApi.subjects.archive(archiveTarget._id);
      setArchiveTarget(null);
      reload();
      showFlash('Subject archived. It remains available for historical reference.');
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Subjects" description={`Courses taught in ${section.name}.`}>
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New subject</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name or code…" label="Search subjects" />
        <FilterSelect label="Status" value={status} onChange={setStatus}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </FilterSelect>
      </FilterBar>

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="status" aria-label="Loading subjects">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 skeleton-shimmer rounded-2xl border border-slate-200/60" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconBook className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">No subjects found</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            Subjects are the courses your section studies — announcements, assignments and marks all belong to a subject.
          </p>
          <div className="mt-5"><Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New subject</Button></div>
        </div>
      ) : (
        <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="list" aria-label="Subjects">
          {items.map((s) => (
            <StaggerItem key={s._id} role="listitem" className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lift active:scale-[0.99]">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-50 text-sm font-bold text-primary-700 ring-1 ring-primary-100">
                  {(s.name ?? '?').trim().slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="min-w-0 truncate text-sm font-semibold text-slate-900">{s.name}</h3>
                    <StatusBadge status={s.status} />
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    <span className="font-mono font-semibold text-slate-600">{s.code}</span>
                    {s.teacherName ? ` · ${s.teacherName}` : ''}
                    {s.creditHours ? ` · ${s.creditHours} credit${s.creditHours === 1 ? '' : 's'}` : ''}
                  </p>
                  {s.description && <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-slate-500">{s.description}</p>}
                </div>
              </div>
              {s.status === 'active' && (
                <div className="mt-3 grid w-full grid-cols-3 gap-1.5 border-t border-slate-100 pt-3 sm:grid-cols-3">
                  <Button variant="ghost" size="sm" className="w-full" icon={IconPencil} onClick={() => setModal({ mode: 'edit', subject: s })}>Edit</Button>
                  <Button variant="ghost" size="sm" className="w-full text-slate-500 hover:text-red-600" icon={IconArchive} onClick={() => { setArchiveTarget(s); setArchiveError(null); }}>Archive</Button>
                  <Button variant="ghost" size="sm" className="w-full text-red-500 hover:text-red-700" icon={IconTrash} onClick={() => { setDeleteTarget(s); setDeleteError(null); }}>Delete</Button>
                </div>
              )}
            </StaggerItem>
          ))}
        </Stagger>
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
        <SubjectForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.subject : null}
          onSaved={(msg) => { showFlash(msg); reload(); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Archive subject?"
        body={
          <p>
            <span className="font-medium">{archiveTarget?.name}</span> will be hidden from new content.
            Existing announcements, assignments and marks keep their history. This can't be undone from the app.
          </p>
        }
        confirmLabel="Archive subject"
        onConfirm={confirmArchive}
        busy={archiveBusy}
        error={archiveError}
        danger
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete subject?"
        body={<p><span className="font-medium">{deleteTarget?.name}</span> will be permanently deleted. A subject can only be deleted when it has no notes, assignments, timetable slots, or assessments left — delete those first if needed.</p>}
        confirmLabel="Delete subject"
        onConfirm={confirmDelete}
        busy={deleteBusy}
        error={deleteError}
        danger
      />
    </div>
  );
}
