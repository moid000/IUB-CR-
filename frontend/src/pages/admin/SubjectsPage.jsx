import { useState } from 'react';
import { adminApi } from '../../api/admin.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, SearchInput, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { IconPlus, IconPencil, IconArchive } from '../../components/icons.jsx';

const CODE_RE = /^[A-Z0-9-]{2,12}$/;

function SubjectForm({ open, onClose, initial, onSaved, sections }) {
  const isEdit = Boolean(initial?._id);
  const [section, setSection] = useState(initial?.section?._id ?? initial?.section ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [teacherName, setTeacherName] = useState(initial?.teacherName ?? '');
  const [creditHours, setCreditHours] = useState(initial?.creditHours != null ? String(initial.creditHours) : '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [errors, setErrors] = useState({});

  const activeSections = sections.filter((s) => s.status === 'active');

  const submit = async () => {
    const next = {};
    if (!isEdit && !section) next.section = 'Select a section.';
    if (name.trim().length < 2) next.name = 'Enter the subject name.';
    if (!CODE_RE.test(code.trim().toUpperCase())) next.code = 'Code must be 2–12 letters, digits or dashes.';
    if (creditHours && (!Number.isInteger(Number(creditHours)) || Number(creditHours) < 1)) {
      next.creditHours = 'Credit hours must be a whole number of at least 1.';
    }
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = {
      name: name.trim(),
      code: code.trim().toUpperCase(), // normalized like the backend
    };
    if (teacherName.trim()) body.teacherName = teacherName.trim();
    if (creditHours) body.creditHours = Number(creditHours);
    if (description.trim()) body.description = description.trim();

    if (isEdit) await adminApi.subjects.update(initial._id, body);
    else await adminApi.subjects.create({ ...body, section });
    onSaved(isEdit ? 'Subject updated.' : 'Subject created.');
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit subject' : 'New subject'} submitLabel={isEdit ? 'Save changes' : 'Create subject'} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          {!isEdit && (
            <Select label="Section" required id="subject-section" value={section} onChange={(e) => setSection(e.target.value)} error={errors.section ?? null}>
              <option value="">Select section…</option>
              {activeSections.map((s) => (
                <option key={s._id} value={s._id}>{s.name} — {s.department?.name}, Sem {s.semester} ({s.session?.name})</option>
              ))}
              {activeSections.length === 0 && <option value="" disabled>No active sections — create a section first.</option>}
            </Select>
          )}
          {isEdit && (
            <Alert variant="info">
              Subject codes are unique within a section. Archived subjects cannot be modified.
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Subject name" required id="subject-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Data Structures" error={errors.name ?? fieldErrors?.name ?? null} />
            <Input label="Code" required id="subject-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="CS-201" hint="2–12 letters, digits or dashes — stored uppercase." error={errors.code ?? fieldErrors?.code ?? null} />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Teacher (optional)" id="subject-teacher" value={teacherName} onChange={(e) => setTeacherName(e.target.value)} placeholder="Dr. Ahmed" error={fieldErrors?.teacherName ?? null} />
            <Input label="Credit hours (optional)" id="subject-credits" type="number" min="1" step="1" value={creditHours} onChange={(e) => setCreditHours(e.target.value)} error={errors.creditHours ?? fieldErrors?.creditHours ?? null} />
          </div>
          <div>
            <label htmlFor="subject-description" className="mb-1.5 block text-sm font-medium text-slate-700">Description (optional)</label>
            <textarea
              id="subject-description" rows="3" value={description}
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
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [sectionId, setSectionId] = useState('all');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => adminApi.subjects.list({
      search: debouncedSearch || undefined,
      sectionId: sectionId !== 'all' ? sectionId : undefined,
      status: status !== 'all' ? status : undefined,
      page, limit: 20,
    }),
    [debouncedSearch, sectionId, status, page]
  );

  const { items: sections } = useAdminQuery(() => adminApi.sections.list({}), []);

  // Reset to page 1 when filters change
  const [lastKey, setLastKey] = useState('');
  const key = `${debouncedSearch}|${sectionId}|${status}`;
  if (key !== lastKey) { setLastKey(key); setPage(1); }

  const confirmArchive = async () => {
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      await adminApi.subjects.archive(archiveTarget._id);
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
    {
      key: 'section', header: 'Section',
      render: (s) => s.section
        ? <span className="text-slate-800">{s.section.name}<span className="block text-xs text-slate-500">Sem {s.section.semester}{s.section.status === 'archived' ? ' · archived section' : ''}</span></span>
        : '—',
    },
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
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Subjects" description="Courses taught within class sections.">
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New subject</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name or code…" label="Search subjects" />
        <FilterSelect label="Section" value={sectionId} onChange={setSectionId}>
          <option value="all">All sections</option>
          {sections.map((s) => <option key={s._id} value={s._id}>{s.name} — {s.department?.name}, Sem {s.semester}</option>)}
        </FilterSelect>
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
        emptyDescription="Subjects are the courses a section studies — announcements, assignments and marks all belong to a subject."
        emptyAction={<Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New subject</Button>}
      />

      {modal && (
        <SubjectForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.subject : null}
          sections={sections}
          onSaved={(msg) => { setModal(null); reload(); showFlash(msg); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Archive subject?"
        confirmLabel="Archive subject"
        busy={archiveBusy}
        error={archiveError}
        body={
          <p>
            <span className="font-medium text-slate-800">{archiveTarget?.name}</span> ({archiveTarget?.code}) will be
            archived. Its history stays available for reference — no new active academic operations can happen under
            it.
          </p>
        }
        onConfirm={confirmArchive}
      />
    </>
  );
}
