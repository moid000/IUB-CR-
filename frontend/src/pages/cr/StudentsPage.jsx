import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { formatDate } from '../../admin/format.js';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, SearchInput, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconUserPlus, IconInfo, IconInbox } from '../../components/icons.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * CR student management. The CR can list and PRE-CREATE students for
 * THEIR OWN section only — the backend derives the section; the form never
 * sends section/role/status/password. Students activate via email OTP.
 */
function AddStudentForm({ open, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [rollNo, setRollNo] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState({});

  const submit = async () => {
    const next = {};
    if (name.trim().length < 2) next.name = 'Enter the student\'s full name.';
    if (!rollNo.trim()) next.rollNo = 'Roll number is required.';
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address.';
    if (phone && !/^\+?[0-9\s-]{7,17}$/.test(phone.trim())) next.phone = 'Enter a valid phone number.';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    await crApi.students.precreate({
      name: name.trim(),
      rollNo: rollNo.trim(),
      email: email.trim().toLowerCase(),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
    });
    onSaved('Student added — they\'ll receive an email to activate their account.');
  };

  return (
    <FormModal open={open} onClose={onClose} title="Add student" submitLabel="Add student" onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          <Alert variant="info">
            The student receives an email with an activation link. You never set (or see) their password.
          </Alert>
          <Input label="Full name" required id="student-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ayesha Khan" error={errors.name ?? fieldErrors?.name ?? null} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Roll number" required id="student-roll" value={rollNo} onChange={(e) => setRollNo(e.target.value)} placeholder="FA22-BCS-001" hint="Unique within your section." error={errors.rollNo ?? fieldErrors?.rollNo ?? null} />
            <Input label="Phone (optional)" id="student-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+92 300 1234567" error={errors.phone ?? fieldErrors?.phone ?? null} />
          </div>
          <Input label="Email" required id="student-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ayesha@example.com" hint="They'll activate their account from this email." error={errors.email ?? fieldErrors?.email ?? null} />
        </>
      )}
    </FormModal>
  );
}

/**
 * MOBILE roster (<640px) — owner 2026-10-07: phones previously showed only
 * name + status (the full table needs 540px); now EVERY student comes as a
 * card with ALL details (roll no, email, phone, status, added date).
 * The sm+ DataTable below stays exactly as it was.
 */
function StudentCards({ students, loading, error, onRetry, emptyAction }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-soft sm:hidden">
      {error ? (
        <div className="p-6">
          <Alert variant="danger"><p className="font-medium">{error.message}</p></Alert>
          {onRetry && (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
            </div>
          )}
        </div>
      ) : loading ? (
        <div className="p-4" role="status" aria-label="Loading students">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-2 py-3">
              <Skeleton className="h-5 flex-1" />
              <Skeleton className="h-5 w-24" />
            </div>
          ))}
        </div>
      ) : students.length === 0 ? (
        <div className="p-6">
          <EmptyState
            icon={<IconInbox className="size-10" />}
            title="No students have been added to your section yet."
            description="Add your first student — they'll get an email to activate their account before they can sign in."
            action={emptyAction}
          />
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {students.map((s) => (
            <li key={s._id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900">{s.name}</p>
                  <p className="mt-0.5 font-mono text-xs font-semibold text-slate-800">{s.rollNo || '—'}</p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  <StatusBadge status={s.registrationStatus} />
                  {s.registrationStatus === 'active' && !s.emailVerified && (
                    <Badge variant="neutral">Email unverified</Badge>
                  )}
                </div>
              </div>
              <dl className="mt-2.5 space-y-1 text-sm">
                <div className="flex gap-2">
                  <dt className="shrink-0 text-slate-500">Email</dt>
                  <dd className="min-w-0 flex-1 break-all text-slate-700">{s.email || '—'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0 text-slate-500">Phone</dt>
                  <dd className="min-w-0 flex-1 break-all text-slate-700">{s.phone || '—'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0 text-slate-500">Added</dt>
                  <dd className="min-w-0 flex-1 text-slate-700">{formatDate(s.createdAt)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function StudentsPage() {
  const { user } = useAuth();
  const section = user?.section;

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => crApi.students.list({ page, limit: 100 }), // sections are small; backend caps at 100
    [page]
  );

  // The CR student endpoint has no server search — filter client-side over
  // the loaded roster (bounded by the server's 100-per-page cap).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((s) =>
      [s.name, s.email, s.rollNo, s.phone].some((v) => (v ?? '').toLowerCase().includes(q)));
  }, [items, search]);

  if (!section) return <NoSection />;

  const columns = [
    {
      key: 'rollNo', header: 'Roll No', className: 'hidden sm:table-cell',
      render: (s) => <span className="font-mono text-xs font-semibold text-slate-800">{s.rollNo || '—'}</span>,
    },
    {
      key: 'name', header: 'Student',
      render: (s) => (
        <div>
          <p className="font-medium text-slate-900">{s.name}</p>
          <p className="text-xs text-slate-500 sm:hidden">{s.rollNo || s.email}</p>
        </div>
      ),
    },
    { key: 'email', header: 'Email', className: 'hidden md:table-cell', render: (s) => <span className="text-slate-600">{s.email}</span> },
    { key: 'phone', header: 'Phone', className: 'hidden lg:table-cell', render: (s) => s.phone || '—' },
    {
      key: 'registrationStatus', header: 'Status',
      render: (s) => (
        <div className="space-x-1.5 space-y-1.5 whitespace-nowrap">
          <StatusBadge status={s.registrationStatus} />
          {s.registrationStatus === 'active' && !s.emailVerified && (
            <Badge variant="neutral">Email unverified</Badge>
          )}
        </div>
      ),
    },
    { key: 'createdAt', header: 'Added', className: 'hidden lg:table-cell', render: (s) => <span className="text-xs text-slate-500">{formatDate(s.createdAt)}</span> },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Students" description={`Students enrolled in ${section.name}.`}>
        <Button icon={IconUserPlus} onClick={() => setModal({ mode: 'create' })}>Add student</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      {pagination && pagination.total > 0 && (
        <p className="mb-4 text-sm text-slate-500">
          {pagination.total} student{pagination.total === 1 ? '' : 's'} in your section.
        </p>
      )}

      <div className="mb-4">
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, roll no, email…" label="Search students" />
      </div>

      <div className="hidden sm:block">
      <DataTable
        columns={columns}
        rows={filtered}
        loading={loading}
        error={error}
        onRetry={reload}
        pagination={pagination && pagination.totalPages > 1 ? pagination : null}
        onPageChange={setPage}
        emptyTitle="No students have been added to this section yet."
        emptyDescription="Add your first student — they'll get an email to activate their account before they can sign in."
        emptyAction={<Button icon={IconUserPlus} onClick={() => setModal({ mode: 'create' })}>Add student</Button>}
      />
      </div>

      <StudentCards
        students={filtered}
        loading={loading}
        error={error}
        onRetry={reload}
        emptyAction={<Button icon={IconUserPlus} onClick={() => setModal({ mode: 'create' })}>Add student</Button>}
      />

      <div className="mt-4 flex items-start gap-3 rounded-xl border border-slate-100 bg-white/70 p-4 text-sm text-slate-500">
        <IconInfo className="mt-0.5 size-4 shrink-0 text-slate-400" />
        <p>
          <span className="font-medium text-slate-600">Pending</span> students must activate via the email they received.
          Once activated, they can sign in and appear as active members of your section.
        </p>
      </div>

      {modal?.mode === 'create' && (
        <AddStudentForm open onClose={() => setModal(null)} onSaved={(msg) => { showFlash(msg); reload(); }} />
      )}
    </div>
  );
}
