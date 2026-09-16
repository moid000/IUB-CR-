import { useState } from 'react';
import { SkeletonRows } from '../../components/ui/Skeleton.jsx';
import { adminApi } from '../../api/admin.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { formatDate } from '../../admin/format.js';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { StatusBadge, RegistrationBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, FormModal, SuccessFlash, SearchInput, ConfirmDialog } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { IconUserPlus, IconTrash, IconInfo } from '../../components/icons.jsx';

/**
 * Pre-create CR — backend activation model: admin creates name + email
 * (+ optional phone). The CR then activates their account at /cr/activate
 * via an email OTP. No password is ever set or shown here.
 */
function PrecreateCrForm({ open, onClose, onSaved, sections, departments, sessions }) {
  const [role, setRole] = useState('cr'); // 'cr' | 'gr'
  const roleLabel = role.toUpperCase();
  const [mode, setMode] = useState('existing'); // 'existing' | 'new'
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [department, setDepartment] = useState('');
  const [session, setSession] = useState('');
  const [semester, setSemester] = useState('1');
  const [sectionName, setSectionName] = useState('');
  const [errors, setErrors] = useState({});

  const freeSections = sections.filter((s) => s.status === 'active' && !s[role]);
  const activeDepartments = departments.filter((d) => d.status === 'active');
  const activeSessions = sessions.filter((s) => s.status === 'active');

  const submit = async () => {
    const next = {};
    if (name.trim().length < 2) next.name = 'Enter the CR name.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) next.email = 'Enter a valid email address.';
    if (mode === 'existing' && !sectionId) next.sectionId = 'Select a section for this CR.';
    if (mode === 'new' && !department) next.department = 'Select a department.';
    if (mode === 'new' && !session) next.session = 'Select an academic session.';
    if (mode === 'new' && !/^[A-Z0-9-]{1,16}$/.test(sectionName.trim().toUpperCase())) next.sectionName = 'Use 1–16 letters, digits or dashes.';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = { name: name.trim(), email: email.trim(), role };
    if (phone.trim()) body.phone = phone.trim();
    if (mode === 'existing') body.sectionId = sectionId;
    else {
      body.department = department;
      body.session = session;
      body.semester = Number(semester);
      body.sectionName = sectionName.trim().toUpperCase();
    }
    await adminApi.crs.precreate(body);
    onSaved(`${roleLabel} account pre-created. They can now activate at /${role}/activate using the OTP sent to their email.`);
  };

  return (
    <FormModal open={open} onClose={onClose} title={`Pre-create ${roleLabel} account`} submitLabel={`Create ${roleLabel}`} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          <Alert variant="info">
            <p className="flex items-start gap-2">
              <IconInfo className="mt-0.5 size-4 shrink-0" />
              The {roleLabel} activates their own account at <code className="rounded bg-white/60 px-1">/{role}/activate</code> using an
              email OTP — no password is created here.
            </p>
          </Alert>
          <Select label="Representative role" required id="rep-role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="cr">CR — Class Representative</option>
            <option value="gr">GR — General Representative</option>
          </Select>
          <Input label="Full name" required id="cr-name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name ?? fieldErrors?.name ?? null} />
          <Input label="Email" required id="cr-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cr@iub.edu.pk" hint="Activation OTP is sent to this address." error={errors.email ?? fieldErrors?.email ?? null} />
          <Input label="Phone (optional)" id="cr-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="03xx-xxxxxxx" error={fieldErrors?.phone ?? null} />

          <div className="pt-1">
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-slate-700">Section</legend>
              <div className="grid grid-cols-2 gap-2">
                <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${mode === 'existing' ? 'border-primary-300 bg-primary-50/50' : 'border-slate-200'}`}>
                  <input type="radio" name="cr-mode" className="mt-1 accent-primary-600" checked={mode === 'existing'} onChange={() => setMode('existing')} />
                  <span><span className="font-medium text-slate-800">Existing section</span><span className="block text-xs text-slate-500">{`Assign to a section without a ${roleLabel}`}</span></span>
                </label>
                <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${mode === 'new' ? 'border-primary-300 bg-primary-50/50' : 'border-slate-200'}`}>
                  <input type="radio" name="cr-mode" className="mt-1 accent-primary-600" checked={mode === 'new'} onChange={() => setMode('new')} />
                  <span><span className="font-medium text-slate-800">Create new section</span><span className="block text-xs text-slate-500">{`Section + ${roleLabel} created together`}</span></span>
                </label>
              </div>
            </fieldset>
          </div>

          {mode === 'existing' ? (
            <Select label="Section" required id="cr-section" value={sectionId} onChange={(e) => setSectionId(e.target.value)} error={errors.sectionId ?? null}>
              <option value="">Select a section…</option>
              {freeSections.map((s) => (
                <option key={s._id} value={s._id}>{s.name} — {s.department?.name}, Sem {s.semester} ({s.session?.name})</option>
              ))}
              {freeSections.length === 0 && <option value="" disabled>{`No active sections without a ${roleLabel} — create a section first.`}</option>}
            </Select>
          ) : (
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
              <Select label="Department" required id="cr-dept" value={department} onChange={(e) => setDepartment(e.target.value)} error={errors.department ?? null}>
                <option value="">Select department…</option>
                {activeDepartments.map((d) => <option key={d._id} value={d._id}>{d.name} ({d.code})</option>)}
              </Select>
              <Select label="Academic session" required id="cr-session" value={session} onChange={(e) => setSession(e.target.value)} error={errors.session ?? null}>
                <option value="">Select session…</option>
                {activeSessions.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
              </Select>
              <div className="grid grid-cols-2 gap-4">
                <Select label="Semester" id="cr-semester" value={semester} onChange={(e) => setSemester(e.target.value)}>
                  {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>Semester {n}</option>)}
                </Select>
                <Input label="Section name" required id="cr-section-name" value={sectionName} onChange={(e) => setSectionName(e.target.value)} placeholder="A" error={errors.sectionName ?? fieldErrors?.sectionName ?? null} />
              </div>
            </div>
          )}
        </>
      )}
    </FormModal>
  );
}

/** Assign an unassigned CR to a free active section (dedicated backend flow). */
function AssignToSectionDialog({ open, onClose, cr, onDone }) {
  const { items: sections, loading, error, reload } = useAdminQuery(
    () => adminApi.sections.list({ status: 'active' }),
    []
  );
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const repRole = cr?.role === 'gr' ? 'gr' : 'cr';
  const repLabel = repRole.toUpperCase();
  const freeSections = sections.filter((s) => !s[repRole]);

  const handlePick = async (section) => {
    setBusyId(section._id);
    setActionError(null);
    try {
      await adminApi.sections.assignCr(section._id, cr._id, repRole);
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
      title={`Assign ${cr?.name ?? repLabel} to a section`}
      confirmLabel="Done"
      onConfirm={onClose}
      body={
        <div className="space-y-3">
          {actionError && <Alert variant="danger">{actionError.message}</Alert>}
          {loading ? (
            <SkeletonRows rows={3} />
          ) : error ? (
            <Alert variant="danger">{error.message}</Alert>
          ) : freeSections.length === 0 ? (
            <p className="py-2 text-sm text-slate-500">{`No active sections are currently without a ${repLabel}. Create a section first, or reassign from the Sections page.`}</p>
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto" role="list">
              {freeSections.map((s) => (
                <li key={s._id}>
                  <button
                    type="button"
                    disabled={busyId === s._id}
                    onClick={() => handlePick(s)}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/40"
                  >
                    <span>
                      <span className="block text-sm font-medium text-slate-800">{s.name} — {s.department?.name}</span>
                      <span className="block text-xs text-slate-500">Semester {s.semester} · {s.session?.name}</span>
                    </span>
                    <Badge variant="success">{`No ${repLabel}`}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    />
  );
}

export default function CrsPage() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState(null);
  const [flash, showFlash] = useFlash();
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => adminApi.crs.list({ search: debouncedSearch || undefined, page, limit: 20 }),
    [debouncedSearch, page]
  );

  // Reset to page 1 whenever the search changes
  const [lastSearch, setLastSearch] = useState('');
  if (debouncedSearch !== lastSearch) { setLastSearch(debouncedSearch); setPage(1); }

  const { items: sections } = useAdminQuery(() => adminApi.sections.list({ status: 'active' }), []);
  const { items: departments } = useAdminQuery(() => adminApi.departments.list({}), []);
  const { items: sessions } = useAdminQuery(() => adminApi.sessions.list({}), []);

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await adminApi.crs.delete(deleteTarget._id);
      setDeleteTarget(null);
      reload();
      showFlash('Representative account deleted and unlinked from their section.');
    } catch (err) {
      setDeleteError(err);
    } finally {
      setDeleteBusy(false);
    }
  };

  const columns = [
    {
      key: 'name', header: 'Representative',
      render: (c) => (
        <span>
          <span className="font-medium text-slate-900">{c.name}</span>
          <span className="block text-xs text-slate-500">{c.email}</span>
        </span>
      ),
    },
    {
      key: 'role', header: 'Role',
      render: (c) => <Badge variant="primary">{(c.role ?? 'cr').toUpperCase()}</Badge>,
    },
    { key: 'phone', header: 'Phone', className: 'hidden lg:table-cell', render: (c) => c.phone || '—' },
    {
      key: 'section', header: 'Section',
      render: (c) => {
        const sec = c.section;
        if (!sec) return <Badge variant="neutral">Unassigned</Badge>;
        return <span className="text-slate-800">{sec.name}<span className="block text-xs text-slate-500">Sem {sec.semester} · {sec.department?.name ?? ''}</span></span>;
      },
    },
    { key: 'registrationStatus', header: 'Account', render: (c) => <RegistrationBadge status={c.registrationStatus} emailVerified={c.emailVerified} /> },
    { key: 'createdAt', header: 'Created', className: 'hidden md:table-cell', render: (c) => <span className="text-slate-500">{formatDate(c.createdAt)}</span> },
    {
      key: 'actions', header: '', headerClassName: 'text-right', className: 'text-right',
      render: (c) => (
        <span className="inline-flex items-center gap-1">
          {!(c.section?._id ?? c.section)
            ? <Button variant="ghost" size="sm" icon={IconUserPlus} onClick={() => setAssignTarget(c)}>Assign to section</Button>
            : <span className="text-xs text-slate-400">Managed from Sections</span>}
          <Button variant="ghost" size="sm" icon={IconTrash} className="text-red-500 hover:text-red-700" onClick={() => { setDeleteTarget(c); setDeleteError(null); }}>Delete</Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Class Representatives" description="CRs and GRs — one of each per section, pre-created here and activated via email OTP.">
        <Button icon={IconUserPlus} onClick={() => setCreateOpen(true)}>Pre-create rep</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name or email…" label="Search representatives" />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={items}
        loading={loading}
        error={error}
        onRetry={reload}
        pagination={pagination}
        onPageChange={setPage}
        emptyTitle="No representative accounts yet"
        emptyDescription="Pre-create a CR or GR account — they activate it themselves at /cr/activate or /gr/activate with an email OTP."
        emptyAction={<Button icon={IconUserPlus} onClick={() => setCreateOpen(true)}>Pre-create rep</Button>}
      />

      {createOpen && (
        <PrecreateCrForm
          open
          onClose={() => setCreateOpen(false)}
          onSaved={(msg) => { setCreateOpen(false); reload(); showFlash(msg); }}
          sections={sections}
          departments={departments}
          sessions={sessions}
        />
      )}

      {assignTarget && (
        <AssignToSectionDialog
          open
          cr={assignTarget}
          onClose={() => setAssignTarget(null)}
          onDone={() => { setAssignTarget(null); reload(); showFlash('Representative assigned to section.'); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete representative account?"
        body={<p><span className="font-medium text-slate-800">{deleteTarget?.name}</span> ({deleteTarget?.email}, {(deleteTarget?.role ?? 'cr').toUpperCase()}) will be permanently deleted and unlinked from their section. The person will lose access. This cannot be undone.</p>}
        confirmLabel="Delete account"
        onConfirm={confirmDelete}
        busy={deleteBusy}
        error={deleteError}
        danger
      />
    </>
  );
}
