import { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { formatDate } from '../../admin/format.js';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, ConfirmDialog, FormModal, SuccessFlash, SearchInput } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Spinner } from '../../components/ui/Spinner.jsx';
import { IconPlus, IconPencil, IconArchive, IconTrash, IconUserPlus, IconUserMinus, IconSwap } from '../../components/icons.jsx';

const SECTION_NAME_RE = /^[A-Z0-9-]{1,16}$/;

function SectionForm({ open, onClose, initial, onSaved, departments, sessions }) {
  const isEdit = Boolean(initial?._id);
  const [name, setName] = useState(initial?.name ?? '');
  const [department, setDepartment] = useState(initial?.department?._id ?? initial?.department ?? '');
  const [session, setSession] = useState(initial?.session?._id ?? initial?.session ?? '');
  const [semester, setSemester] = useState(initial?.semester ? String(initial.semester) : '1');
  const [errors, setErrors] = useState({});

  const activeDepartments = departments.filter((d) => d.status === 'active');
  const activeSessions = sessions.filter((s) => s.status === 'active');

  const submit = async () => {
    const next = {};
    if (!isEdit && !department) next.department = 'Select a department.';
    if (!isEdit && !session) next.session = 'Select an academic session.';
    if (!SECTION_NAME_RE.test(name.trim().toUpperCase())) next.name = 'Use 1–16 letters, digits or dashes (e.g. A, B, CS-A).';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    if (isEdit) {
      // Only name + semester are client-editable — never department/session/cr
      await adminApi.sections.update(initial._id, { name: name.trim().toUpperCase(), semester: Number(semester) });
    } else {
      await adminApi.sections.create({
        department, session, semester: Number(semester), name: name.trim().toUpperCase(),
      });
    }
    onSaved(isEdit ? 'Section updated.' : 'Section created.');
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit section' : 'New section'} submitLabel={isEdit ? 'Save changes' : 'Create section'} onSubmit={submit}>
      {(fieldErrors) => (
        <>
          {!isEdit && (
            <>
              <Select label="Department" required id="section-department" value={department} onChange={(e) => setDepartment(e.target.value)} error={errors.department ?? null}>
                <option value="">Select department…</option>
                {activeDepartments.map((d) => <option key={d._id} value={d._id}>{d.name} ({d.code})</option>)}
              </Select>
              <Select label="Academic session" required id="section-session" value={session} onChange={(e) => setSession(e.target.value)} error={errors.session ?? null}>
                <option value="">Select session…</option>
                {activeSessions.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
              </Select>
            </>
          )}
          {isEdit && (
            <Alert variant="info">Department and session are fixed once a section is created. CR assignment has its own dedicated flow.</Alert>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select label="Semester" required id="section-semester" value={semester} onChange={(e) => setSemester(e.target.value)}>
              {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>Semester {n}</option>)}
            </Select>
            <Input
              label="Section name" required id="section-name" value={name}
              onChange={(e) => setName(e.target.value)} placeholder="A"
              hint="1–16 letters, digits or dashes."
              error={errors.name ?? fieldErrors?.name ?? null}
            />
          </div>
        </>
      )}
    </FormModal>
  );
}

/** Assign or reassign a CR to a specific section through the dedicated backend flows. */
function CrAssignDialog({ open, onClose, section, onDone }) {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const { items, loading, error, reload } = useAdminQuery(
    () => adminApi.crs.list({ search: debounced || undefined, limit: 100 }),
    [debounced]
  );
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const handlePick = async (cr) => {
    setBusyId(cr._id);
    setActionError(null);
    try {
      // Dedicated flows — the backend decides assign vs reassign semantics; we
      // only ever send the userId to the section's own CR route.
      const hasSection = Boolean(cr.section?._id ?? cr.section);
      if (hasSection) await adminApi.sections.reassignCr(section._id, cr._id);
      else await adminApi.sections.assignCr(section._id, cr._id);
      onDone();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Assign CR to ${section?.name ?? 'section'}`}
      confirmLabel="Done"
      onConfirm={onClose}
      body={
        <div className="space-y-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search CRs by name or email…" label="Search CRs" />
          {actionError && <Alert variant="danger">{actionError.message}</Alert>}
          {loading ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : error ? (
            <Alert variant="danger">{error.message}</Alert>
          ) : items.length === 0 ? (
            <p className="py-2 text-sm text-slate-500">No CR accounts found. Pre-create a CR first from CR Management.</p>
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto" role="list">
              {items.map((cr) => {
                const crSection = cr.section?._id ?? cr.section;
                const isHere = String(crSection) === String(section?._id);
                return (
                  <li key={cr._id}>
                    <button
                      type="button"
                      disabled={isHere || busyId === cr._id}
                      onClick={() => handlePick(cr)}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors
                        ${isHere ? 'border-primary-200 bg-primary-50' : 'border-slate-200 bg-white hover:border-primary-300 hover:bg-primary-50/40'}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-800">{cr.name}</span>
                        <span className="block truncate text-xs text-slate-500">{cr.email}</span>
                      </span>
                      {isHere ? (
                        <Badge variant="primary">Current CR</Badge>
                      ) : crSection ? (
                        <Badge variant="warning" title="CRs currently in another section are moved via reassignment">In {cr.section?.name ?? 'another section'}</Badge>
                      ) : (
                        <Badge variant="success">Unassigned</Badge>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-slate-500">
            Choosing a CR from another section moves them here (their old section loses its CR). Unassigned CRs are added directly.
          </p>
        </div>
      }
    />
  );
}

export default function SectionsPage() {
  const [department, setDepartment] = useState('all');
  const [session, setSession] = useState('all');
  const [status, setStatus] = useState('active');
  const [modal, setModal] = useState(null);
  const [assignTarget, setAssignTarget] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [flash, showFlash] = useFlash();

  const params = {
    department: department !== 'all' ? department : undefined,
    session: session !== 'all' ? session : undefined,
    status: status !== 'all' ? status : undefined,
  };
  const { items, loading, error, reload } = useAdminQuery(
    () => adminApi.sections.list(params),
    [department, session, status]
  );

  // Filter options — small reference lists
  const { items: departments } = useAdminQuery(() => adminApi.departments.list({}), []);
  const { items: sessions } = useAdminQuery(() => adminApi.sessions.list({}), []);

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await adminApi.sections.delete(deleteTarget._id);
      setDeleteTarget(null);
      reload();
      showFlash('Section deleted.');
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
      await adminApi.sections.archive(archiveTarget._id);
      setArchiveTarget(null);
      reload();
      showFlash('Section archived. It remains visible as historical record.');
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiveBusy(false);
    }
  };

  const confirmRemoveCr = async () => {
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await adminApi.sections.removeCr(removeTarget._id);
      setRemoveTarget(null);
      reload();
      showFlash('CR removed from section. The CR account itself is untouched.');
    } catch (err) {
      setRemoveError(err);
    } finally {
      setRemoveBusy(false);
    }
  };

  const columns = [
    {
      key: 'name', header: 'Section',
      render: (s) => (
        <span className="font-medium text-slate-900">
          {s.name}
          {s.status === 'archived' && <Badge variant="neutral" className="ml-1.5">Historical</Badge>}
        </span>
      ),
    },
    { key: 'department', header: 'Department', className: 'hidden md:table-cell', render: (s) => s.department ? `${s.department.name} (${s.department.code})` : '—' },
    { key: 'session', header: 'Session', className: 'hidden md:table-cell', render: (s) => s.session?.name ?? '—' },
    { key: 'semester', header: 'Sem.' },
    { key: 'cr', header: 'CR', render: (s) => s.cr ? <span className="text-slate-800">{s.cr.name}<span className="block text-xs text-slate-500">{s.cr.email}</span></span> : <span className="text-xs text-slate-400">Not assigned</span> },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    {
      key: 'actions', header: '', headerClassName: 'text-right', className: 'text-right whitespace-nowrap',
      render: (s) => (
        <div className="flex justify-end gap-1">
          {s.status === 'active' && !s.cr && (
            <Button variant="ghost" size="sm" icon={IconUserPlus} onClick={() => setAssignTarget(s)}>Assign CR</Button>
          )}
          {s.status === 'active' && s.cr && (
            <Button variant="ghost" size="sm" icon={IconUserMinus} className="text-slate-500 hover:text-red-600" onClick={() => { setRemoveTarget(s); setRemoveError(null); }}>Remove CR</Button>
          )}
          <Button variant="ghost" size="sm" icon={IconPencil} onClick={() => setModal({ mode: 'edit', section: s })}>Edit</Button>
          {s.status === 'active' && (
            <>
              <Button variant="ghost" size="sm" icon={IconArchive} className="text-slate-500 hover:text-red-600" onClick={() => { setArchiveTarget(s); setArchiveError(null); }}>Archive</Button>
              <Button variant="ghost" size="sm" icon={IconTrash} className="text-red-500 hover:text-red-700" onClick={() => { setDeleteTarget(s); setDeleteError(null); }}>Delete</Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Sections" description="Class sections within departments and academic sessions.">
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New section</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <FilterSelect label="Department" value={department} onChange={setDepartment}>
          <option value="all">All departments</option>
          {departments.map((d) => <option key={d._id} value={d._id}>{d.name} ({d.code})</option>)}
        </FilterSelect>
        <FilterSelect label="Session" value={session} onChange={setSession}>
          <option value="all">All sessions</option>
          {sessions.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
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
        emptyTitle="No sections found"
        emptyDescription="Sections organize students under a department, session and semester. Create one to get started."
        emptyAction={<Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New section</Button>}
      />

      {modal && (
        <SectionForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.section : null}
          departments={departments}
          sessions={sessions}
          onSaved={(msg) => { setModal(null); reload(); showFlash(msg); }}
        />
      )}

      {assignTarget && (
        <CrAssignDialog
          open
          section={assignTarget}
          onClose={() => setAssignTarget(null)}
          onDone={() => { setAssignTarget(null); reload(); showFlash('CR assigned to section.'); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        title="Remove CR from section?"
        confirmLabel="Remove CR"
        danger
        busy={removeBusy}
        error={removeError}
        body={
          <p>
            <span className="font-medium text-slate-800">{removeTarget?.cr?.name}</span> will be unlinked from section{' '}
            <span className="font-medium text-slate-800">{removeTarget?.name}</span>. The CR account itself is kept — it can be
            assigned to another section later.
          </p>
        }
        onConfirm={confirmRemoveCr}
      />

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Archive section?"
        confirmLabel="Archive section"
        busy={archiveBusy}
        error={archiveError}
        body={
          <p>
            Section <span className="font-medium text-slate-800">{archiveTarget?.name}</span> will be archived as a
            historical class record. It remains visible with its students and history, but no new active academic
            operations can happen under it.
          </p>
        }
        onConfirm={confirmArchive}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete section?"
        body={<p>Section <span className="font-medium text-slate-800">{deleteTarget?.name}</span> will be permanently deleted. A section can only be deleted once it has no assigned CR, no students, and no subjects left — remove those first.</p>}
        confirmLabel="Delete section"
        onConfirm={confirmDelete}
        busy={deleteBusy}
        error={deleteError}
        danger
      />
    </>
  );
}
