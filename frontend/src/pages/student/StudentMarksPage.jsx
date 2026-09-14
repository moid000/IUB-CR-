import { studentApi } from '../../api/student.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { formatDate } from '../../admin/format.js';
import { PageHeader } from '../../components/admin/controls.jsx';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import { IconCheckCircle } from '../../components/icons.jsx';

const STATUS_BADGE = {
  open: 'primary',
  finalized: 'success',
  archived: 'neutral',
};

/**
 * Marks — READ-ONLY. Drafts are never returned by the backend; a missing
 * mark stays missing (never rendered as zero).
 */
export default function StudentMarksPage() {
  const { user } = useAuth();
  const section = user?.section;
  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.marks.assessments({ page: 1, limit: 50 }),
    []
  );

  if (!section) return <NoSection />;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Marks"
        description={`Assessment results for Section ${section.name}. Results appear once your CR enters and finalizes them.`}
      />
      <DataTable
        columns={[
          {
            key: 'title', header: 'Assessment',
            render: (r) => (
              <div>
                <p className="font-medium text-slate-800">{r.title}</p>
                <p className="text-xs text-slate-500">{r.subject?.name ?? ''}{r.type ? ` · ${r.type}` : ''}</p>
              </div>
            ),
          },
          { key: 'assessmentDate', header: 'Date', className: 'hidden sm:table-cell', render: (r) => formatDate(r.assessmentDate) },
          { key: 'totalMarks', header: 'Total', render: (r) => <span className="font-medium text-slate-700">{r.totalMarks}</span> },
          {
            key: 'myMark', header: 'Marks obtained',
            render: (r) => {
              if (r.status !== 'finalized') {
                return <Badge variant="neutral">Pending</Badge>; // not finalized yet — nothing to show
              }
              if (!r.myMark) return <Badge variant="warning">Not entered</Badge>; // genuinely missing — NOT zero
              return (
                <span className="font-semibold text-slate-900">{r.myMark.marksObtained}<span className="text-slate-400"> / {r.totalMarks}</span></span>
              );
            },
          },
          {
            key: 'status', header: 'Status',
            render: (r) => <Badge variant={STATUS_BADGE[r.status] ?? 'neutral'}>{r.status}</Badge>,
          },
        ]}
        rows={items}
        loading={loading}
        error={error}
        onRetry={reload}
        emptyTitle="No assessment results available yet."
        emptyDescription="When your CR creates and finalizes assessments, your results appear here."
      />
      {items.length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
          <IconCheckCircle className="size-3.5" />
          Marks become visible once finalized. Missing marks are shown as missing — never as zero.
        </p>
      )}
    </div>
  );
}
