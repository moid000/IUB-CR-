import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, SearchInput, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconPlus, IconPencil, IconArchive } from '../../components/icons.jsx';

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
          <div>
            <label htmlFor="cr-subject-description" className="mb-1.5 block text-sm font-medium text-slate-700">Description (optional)</label>
            <textarea
              id="cr-subject-description" rows="3" value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="block w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-300 focus:border-primary-500"
              placeholder="Brief outline of the subject…"
            />
            {fieldErrors?.description && <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">{fieldErrors.description}</p>}
          </div>
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
    [debouncedSearch, status, page]
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

  const columns = [
    { key: 'code', header: 'Code', render: (s) => <span className="font-mono text-xs font-semibold text-slate-800">{s.code}</span> },
    { key: 'name', header: 'Subject', render: (s) => <span className="font-medium text-slate-900">{s.name}</span> },
    { key: 'teacherName', header: 'Teacher', className: 'hidden lg:table-cell', render: (s) => s.teacherName || '—' },
    { key: 'creditHours', header: 'Credits', className: 'hidden md:table-cell', render: (s) => s.creditHours ?? '—' },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    {
      key: 'actions', header: '', headerClassName: 'text-right', className: 'text-right whitespace-nowrap',
      render: (s) => (
        <div className="flex justify-end gap-1">
          {s.status === 'active' && (
            <>
              <Button variant="ghost" size="sm" icon={IconPencil} onClick={() => setModal({ mode: 'edit', subject: s })}>Edit</Button>
              <Button variant="ghost" size="sm" icon={IconArchive} className="text-slate-500 hover:text-red-600" onClick={() => { setArchiveTarget(s); setArchiveError(null); }}>Archive</Button>
              <Button variant="ghost" size="sm" icon={IconTrash} className="text-red-500 hover:text-red-700" onClick={() => { setDeleteTarget(s); setDeleteError(null); }}>Delete</Button>
            </>
          )}
        </div>
      ),
    },
  ];

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

      <DataTable
        columns={columns}
        rows={items}
        loading={loading}
        error={error}
        onRetry={reload}
        pagination={pagination}
        onPageChange={setPage}
        emptyTitle="No subjects found"
        emptyDescription="Subjects are the courses your section studies — announcements, assignments and marks all belong to a subject."
        emptyAction={<Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New subject</Button>}
      />

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
