import { useMemo, useState } from 'react';
import { adminApi } from '../../api/admin.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { formatDate } from '../../admin/format.js';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, SearchInput, FilterSelect, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { IconPlus, IconPencil, IconArchive, IconTrash } from '../../components/icons.jsx';

const CODE_RE = /^[A-Z0-9-]{2,12}$/;

function DepartmentForm({ open, onClose, initial, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [errors, setErrors] = useState({});

  const submit = async () => {
    const next = {};
    const trimmedName = name.trim();
    const normalizedCode = code.trim().toUpperCase();
    if (trimmedName.length < 2) next.name = 'Enter a department name (at least 2 characters).';
    if (!CODE_RE.test(normalizedCode)) next.code = 'Code must be 2–12 letters, digits or dashes.';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = { name: trimmedName, code: normalizedCode };
    if (isEdit) await adminApi.departments.update(initial._id, body);
    else await adminApi.departments.create(body);
    onSaved(isEdit ? 'Department updated.' : 'Department created.');
  };

  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit department' : 'New department'}
      submitLabel={isEdit ? 'Save changes' : 'Create department'}
      onSubmit={submit}
    >
      {(fieldErrors) => (
        <>
          <Input
            label="Department name" required id="dept-name" value={name}
            onChange={(e) => setName(e.target.value)} placeholder="Computer Science"
            error={errors.name ?? fieldErrors?.name ?? null}
          />
          <Input
            label="Code" required id="dept-code" value={code}
            onChange={(e) => setCode(e.target.value)} placeholder="CS"
            hint="2–12 letters, digits or dashes. Used as the department identifier."
            error={errors.code ?? fieldErrors?.code ?? null}
          />
        </>
      )}
    </FormModal>
  );
}

export default function DepartmentsPage() {
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [modal, setModal] = useState(null); // {mode:'create'} | {mode:'edit', dept}
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items, loading, error, reload } = useAdminQuery(
    () => adminApi.departments.list(status !== 'all' ? { status } : {}),
    [status]
  );

  // Departments are a small reference list — client-side search is appropriate
  const rows = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return items;
    return items.filter((d) => d.name?.toLowerCase().includes(q) || d.code?.toLowerCase().includes(q));
  }, [items, debouncedSearch]);

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await adminApi.departments.delete(deleteTarget._id);
      setDeleteTarget(null);
      reload();
      showFlash('Department deleted.');
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
      await adminApi.departments.archive(archiveTarget._id);
      setArchiveTarget(null);
      reload();
      showFlash('Department archived. It stays available for historical reference.');
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiveBusy(false);
    }
  };

  const columns = [
    { key: 'name', header: 'Name', render: (d) => <span className="font-medium text-slate-900">{d.name}</span> },
    { key: 'code', header: 'Code' },
    { key: 'status', header: 'Status', render: (d) => <StatusBadge status={d.status} /> },
    { key: 'createdAt', header: 'Created', className: 'hidden md:table-cell', render: (d) => <span className="text-slate-500">{formatDate(d.createdAt)}</span> },
    {
      key: 'actions', header: '', headerClassName: 'text-right', className: 'text-right whitespace-nowrap',
      render: (d) => d.status === 'active' ? (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" icon={IconPencil} onClick={() => setModal({ mode: 'edit', dept: d })}>Edit</Button>
          <Button variant="ghost" size="sm" icon={IconArchive} className="text-slate-500 hover:text-red-600" onClick={() => { setArchiveTarget(d); setArchiveError(null); }}>Archive</Button>
          <Button variant="ghost" size="sm" icon={IconTrash} className="text-red-500 hover:text-red-700" onClick={() => { setDeleteTarget(d); setDeleteError(null); }}>Delete</Button>
        </div>
      ) : <span className="text-xs text-slate-400">—</span>,
    },
  ];

  return (
    <>
      <PageHeader title="Departments" description="Faculties and departments that academic sections belong to.">
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New department</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name or code…" label="Search departments" />
        <FilterSelect label="Status" value={status} onChange={(v) => setStatus(v)}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </FilterSelect>
      </FilterBar>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={reload}
        emptyTitle="No departments yet"
        emptyDescription="Create your first department — sections and subjects are organized under departments."
        emptyAction={<Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New department</Button>}
      />

      {modal && (
        <DepartmentForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.dept : null}
          onSaved={(msg) => { setModal(null); reload(); showFlash(msg); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Archive department?"
        confirmLabel="Archive department"
        busy={archiveBusy}
        error={archiveError}
        body={
          <p>
            <span className="font-medium text-slate-800">{archiveTarget?.name}</span> will be moved to archived
            status. Archived departments remain visible for historical reference and cannot be used for new active
            academic operations.
          </p>
        }
        onConfirm={confirmArchive}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete department?"
        body={<p><span className="font-medium text-slate-800">{deleteTarget?.name}</span> will be permanently deleted. A department can only be deleted once it has no sections left — archive or delete those first.</p>}
        confirmLabel="Delete department"
        onConfirm={confirmDelete}
        busy={deleteBusy}
        error={deleteError}
        danger
      />
    </>
  );
}
