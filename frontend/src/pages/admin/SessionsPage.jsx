import { useState } from 'react';
import { adminApi } from '../../api/admin.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { formatDate } from '../../admin/format.js';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { IconPlus, IconPencil, IconArchive, IconTrash } from '../../components/icons.jsx';

function SessionForm({ open, onClose, initial, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [name, setName] = useState(initial?.name ?? '');
  const [startedAt, setStartedAt] = useState(initial?.startedAt ? String(initial.startedAt).slice(0, 10) : '');
  const [endedAt, setEndedAt] = useState(initial?.endedAt ? String(initial.endedAt).slice(0, 10) : '');
  const [status, setStatus] = useState(initial?.status ?? 'active');
  const [errors, setErrors] = useState({});

  const submit = async () => {
    const next = {};
    if (name.trim().length < 2) next.name = 'Enter a session name (at least 2 characters).';
    if (startedAt && endedAt && new Date(endedAt) <= new Date(startedAt)) {
      next.endedAt = 'End date must be after the start date.';
    }
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = { name: name.trim(), status };
    if (startedAt) body.startedAt = startedAt;
    if (endedAt) body.endedAt = endedAt;
    if (isEdit) await adminApi.sessions.update(initial._id, body);
    else await adminApi.sessions.create(body);
    onSaved(isEdit ? 'Academic session updated.' : 'Academic session created.');
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit academic session' : 'New academic session'} submitLabel={isEdit ? 'Save changes' : 'Create session'} onSubmit={submit}>
      {(fieldErrors) => (
        <>
          {!isEdit && (
            <Alert variant="info">
              Only one academic session can be active at a time. Creating this session as active will fail if another session is already active.
            </Alert>
          )}
          <Input
            label="Session name" required id="session-name" value={name}
            onChange={(e) => setName(e.target.value)} placeholder="Fall 2026"
            error={errors.name ?? fieldErrors?.name ?? null}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Start date" id="session-start" type="date" value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
              error={fieldErrors?.startedAt ?? null}
            />
            <Input
              label="End date" id="session-end" type="date" value={endedAt}
              onChange={(e) => setEndedAt(e.target.value)}
              error={errors.endedAt ?? fieldErrors?.endedAt ?? null}
            />
          </div>
          <Select label="Status" id="session-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active — current session</option>
            <option value="archived">Archived — historical session</option>
          </Select>
        </>
      )}
    </FormModal>
  );
}

export default function SessionsPage() {
  const [status, setStatus] = useState('all');
  const [modal, setModal] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items, loading, error, reload } = useAdminQuery(
    () => adminApi.sessions.list(status !== 'all' ? { status } : {}),
    [status]
  );

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await adminApi.sessions.delete(deleteTarget._id);
      setDeleteTarget(null);
      reload();
      showFlash('Session deleted.');
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
      await adminApi.sessions.archive(archiveTarget._id);
      setArchiveTarget(null);
      reload();
      showFlash('Academic session archived. It stays available for historical reference.');
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiveBusy(false);
    }
  };

  const columns = [
    {
      key: 'name', header: 'Session',
      render: (s) => (
        <span className="font-medium text-slate-900">
          {s.name}{' '}
          {s.status === 'active' && <Badge variant="primary" className="ml-1">Current</Badge>}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'startedAt', header: 'Start', className: 'hidden md:table-cell', render: (s) => formatDate(s.startedAt) },
    { key: 'endedAt', header: 'End', className: 'hidden md:table-cell', render: (s) => formatDate(s.endedAt) },
    { key: 'createdAt', header: 'Created', className: 'hidden lg:table-cell', render: (s) => <span className="text-slate-500">{formatDate(s.createdAt)}</span> },
    {
      key: 'actions', header: '', headerClassName: 'text-right', className: 'text-right',
      render: (s) => s.status === 'active' ? (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" icon={IconPencil} onClick={() => setModal({ mode: 'edit', session: s })}>Edit</Button>
          <Button variant="ghost" size="sm" icon={IconArchive} className="text-slate-500 hover:text-red-600" onClick={() => { setArchiveTarget(s); setArchiveError(null); }}>Archive</Button>
          <Button variant="ghost" size="sm" icon={IconTrash} className="text-red-500 hover:text-red-700" onClick={() => { setDeleteTarget(s); setDeleteError(null); }}>Delete</Button>
        </div>
      ) : (
        <Button variant="ghost" size="sm" icon={IconPencil} onClick={() => setModal({ mode: 'edit', session: s })}>Edit</Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Academic Sessions" description="Semester cycles that sections belong to. One session can be active at a time.">
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New session</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <FilterSelect label="Status" value={status} onChange={(v) => setStatus(v)}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </FilterSelect>
      </FilterBar>

      <DataTable
        columns={columns}
        rows={items}
        loading={loading}
        error={error}
        onRetry={reload}
        emptyTitle="No academic sessions yet"
        emptyDescription="Create a session (e.g. Fall 2026) before adding sections — every section belongs to a session."
        emptyAction={<Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New session</Button>}
      />

      {modal && (
        <SessionForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.session : null}
          onSaved={(msg) => { setModal(null); reload(); showFlash(msg); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Archive academic session?"
        confirmLabel="Archive session"
        busy={archiveBusy}
        error={archiveError}
        body={
          <p>
            <span className="font-medium text-slate-800">{archiveTarget?.name}</span> will be archived. It remains
            available for historical reference — no new active sections can be created under it.
          </p>
        }
        onConfirm={confirmArchive}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete session?"
        body={<p><span className="font-medium text-slate-800">{deleteTarget?.name}</span> will be permanently deleted. A session can only be deleted once it has no sections left — archive or delete those first.</p>}
        confirmLabel="Delete session"
        onConfirm={confirmDelete}
        busy={deleteBusy}
        error={deleteError}
        danger
      />
    </>
  );
}
