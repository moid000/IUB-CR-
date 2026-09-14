import { useState } from 'react';
import { adminApi } from '../../api/admin.js';
import { useAdminQuery, useDebounced } from '../../admin/hooks.js';
import { formatDate } from '../../admin/format.js';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { RegistrationBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, SearchInput } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { IconInfo } from '../../components/icons.jsx';

/**
 * Admin student directory — READ-ONLY.
 * Students are pre-created by their section's CR (POST /api/cr/students) and
 * activate their own accounts at /student/activate via email OTP. The admin
 * UI has no student-creation endpoint — this list is the authoritative view.
 */
export default function StudentsPage() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [department, setDepartment] = useState('all');
  const [session, setSession] = useState('all');
  const [section, setSection] = useState('all');
  const [page, setPage] = useState(1);

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => adminApi.students.list({
      search: debouncedSearch || undefined,
      department: department !== 'all' ? department : undefined,
      session: session !== 'all' ? session : undefined,
      section: section !== 'all' ? section : undefined,
      page, limit: 20,
    }),
    [debouncedSearch, department, session, section, page]
  );

  const { items: departments } = useAdminQuery(() => adminApi.departments.list({}), []);
  const { items: sessions } = useAdminQuery(() => adminApi.sessions.list({}), []);
  const { items: sections } = useAdminQuery(() => adminApi.sections.list({}), []);

  // Reset to page 1 when any filter changes
  const [lastKey, setLastKey] = useState('');
  const key = `${debouncedSearch}|${department}|${session}|${section}`;
  if (key !== lastKey) { setLastKey(key); setPage(1); }

  const columns = [
    {
      key: 'name', header: 'Student',
      render: (s) => (
        <span>
          <span className="font-medium text-slate-900">{s.name}</span>
          {s.rollNo && <span className="block text-xs text-slate-500">Roll no. {s.rollNo}</span>}
        </span>
      ),
    },
    { key: 'email', header: 'Email', className: 'hidden md:table-cell' },
    { key: 'phone', header: 'Phone', className: 'hidden lg:table-cell', render: (s) => s.phone || '—' },
    {
      key: 'section', header: 'Section',
      render: (s) => s.section
        ? <span className="text-slate-800">{s.section.name}<span className="block text-xs text-slate-500">Sem {s.semester ?? s.section.semester} · {s.section.department?.name ?? ''}</span></span>
        : <span className="text-xs text-slate-400">No section</span>,
    },
    { key: 'registrationStatus', header: 'Account', render: (s) => <RegistrationBadge status={s.registrationStatus} emailVerified={s.emailVerified} /> },
    { key: 'createdAt', header: 'Added', className: 'hidden lg:table-cell', render: (s) => <span className="text-slate-500">{formatDate(s.createdAt)}</span> },
  ];

  return (
    <>
      <PageHeader title="Students" description="Student directory across all sections." />

      <Alert variant="info" className="mb-4">
        <p className="flex items-start gap-2">
          <IconInfo className="mt-0.5 size-4 shrink-0" />
          Students are added by their section's CR and activate their own accounts at{' '}
          <code className="rounded bg-white/60 px-1">/student/activate</code> using an email OTP. This page is the
          read-only directory.
        </p>
      </Alert>

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, roll number or email…" label="Search students" />
        <FilterSelect label="Department" value={department} onChange={setDepartment}>
          <option value="all">All departments</option>
          {departments.map((d) => <option key={d._id} value={d._id}>{d.name} ({d.code})</option>)}
        </FilterSelect>
        <FilterSelect label="Session" value={session} onChange={setSession}>
          <option value="all">All sessions</option>
          {sessions.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
        </FilterSelect>
        <FilterSelect label="Section" value={section} onChange={setSection}>
          <option value="all">All sections</option>
          {sections.map((s) => <option key={s._id} value={s._id}>{s.name} — {s.department?.name}, Sem {s.semester}</option>)}
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
        emptyTitle="No students found"
        emptyDescription="Students appear here once their section's CR adds them. Try clearing the filters."
      />
    </>
  );
}
