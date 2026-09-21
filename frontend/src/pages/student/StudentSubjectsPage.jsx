import { studentApi } from '../../api/student.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { PageHeader } from '../../components/admin/controls.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { IconBook } from '../../components/icons.jsx';

/** One subject card — compact, scannable, calendar-app feel. */
function SubjectCard({ s }) {
  const initials = (s.name ?? '?').trim().slice(0, 2).toUpperCase();
  const meta = [
    s.teacherName ? `Taught by ${s.teacherName}` : null,
    s.creditHours ? `${s.creditHours} credit${s.creditHours === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="group rounded-2xl border border-slate-200/80 bg-white p-4 shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lift">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-50 text-sm font-bold text-primary-700 ring-1 ring-primary-100">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 truncate text-sm font-semibold text-slate-900 transition-colors group-hover:text-primary-700">{s.name}</h3>
            <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-500">{s.code}</span>
          </div>
          {meta && <p className="mt-1 text-xs text-slate-500">{meta}</p>}
          {s.description && <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-slate-500">{s.description}</p>}
        </div>
      </div>
    </div>
  );
}

/** Read-only subject list — always scoped to the student's OWN section. */
export default function StudentSubjectsPage() {
  const { user } = useAuth();
  const section = user?.section;
  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.subjects.list({ status: 'active', page: 1, limit: 50 }),
    [],
    () => studentApi.subjects.cachedList({ status: 'active', page: 1, limit: 50 })
  );

  if (!section) return <NoSection />;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="My Subjects"
        description={`Active subjects for ${section.department?.name ?? 'your department'} — Section ${section.name}.`}
      />

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="status" aria-label="Loading subjects">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[104px] skeleton-shimmer rounded-2xl border border-slate-200/60" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconBook className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">No subjects are available for your section yet.</h3>
          <p className="mt-1 text-sm text-slate-500">Your CR is still setting up the subject list — check back soon.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="list" aria-label="My subjects">
          {items.map((s) => (
            <div key={s._id} role="listitem">
              <SubjectCard s={s} />
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <p className="mt-3 text-center text-xs text-slate-400">
          {items.length} active subject{items.length === 1 ? '' : 's'} — archived subjects are hidden.
        </p>
      )}
    </div>
  );
}
