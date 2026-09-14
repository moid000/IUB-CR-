import { studentApi } from '../../api/student.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { PageHeader } from '../../components/admin/controls.jsx';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { NoSection } from '../../student/NoSection.jsx';

/** Read-only subject list — always scoped to the student's OWN section. */
export default function StudentSubjectsPage() {
  const { user } = useAuth();
  const section = user?.section;
  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.subjects.list({ status: 'active', page: 1, limit: 50 }),
    []
  );

  if (!section) return <NoSection />;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="My Subjects"
        description={`Active subjects for ${section.department?.name ?? 'your department'} — Section ${section.name}.`}
      />
      <DataTable
        columns={[
          {
            key: 'name', header: 'Subject',
            render: (r) => (
              <div>
                <p className="font-medium text-slate-800">{r.name}</p>
                {r.description && <p className="text-xs text-slate-500">{r.description}</p>}
              </div>
            ),
          },
          { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-xs text-slate-600">{r.code}</span> },
          { key: 'teacherName', header: 'Instructor', className: 'hidden sm:table-cell' },
          { key: 'creditHours', header: 'Credit hours', className: 'hidden md:table-cell' },
          { key: 'status', header: 'Status', render: (r) => <Badge variant={r.status === 'active' ? 'success' : 'neutral'}>{r.status}</Badge> },
        ]}
        rows={items}
        loading={loading}
        error={error}
        onRetry={reload}
        emptyTitle="No subjects are available for your section yet."
        emptyDescription="Your CR is still setting up the subject list — check back soon."
      />
    </div>
  );
}
