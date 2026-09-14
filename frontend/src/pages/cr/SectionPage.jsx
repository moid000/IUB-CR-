import { useAuth } from '../../auth/AuthContext.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { formatDate } from '../../admin/format.js';
import { IconLayers, IconBuilding, IconCalendar, IconUsers, IconInfo } from '../../components/icons.jsx';

/**
 * "My Section" — the CR's server-assigned academic context.
 * There is deliberately NO section selector: identity comes from /api/auth/me.
 */
export default function SectionPage() {
  const { user } = useAuth();
  const section = user?.section;

  if (!section) return <NoSection />;

  const rows = [
    { icon: IconLayers, label: 'Section', value: section.name },
    { icon: IconBuilding, label: 'Department', value: section.department?.name ? `${section.department.name}${section.department.code ? ` (${section.department.code})` : ''}` : '—' },
    { icon: IconCalendar, label: 'Semester', value: section.semester != null ? `Semester ${section.semester}` : '—' },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Badge variant="primary">My Section</Badge>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{section.name}</h2>
            <p className="mt-1 text-sm text-slate-500">
              Your workspace is bound to this section — every student, subject and piece of content you manage belongs to it automatically.
            </p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium
            ${section.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
            <span className={`size-1.5 rounded-full ${section.status === 'active' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            {section.status}
          </span>
        </div>

        <dl className="mt-6 grid gap-3 sm:grid-cols-2">
          {rows.map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
              <Icon className="mt-0.5 size-4 shrink-0 text-primary-500" />
              <div className="min-w-0">
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
                <dd className="mt-0.5 truncate text-sm font-medium text-slate-800">{value}</dd>
              </div>
            </div>
          ))}
        </dl>
      </div>

      <Card className="p-6 sm:p-8">
        <h3 className="text-sm font-semibold text-slate-900">Your role</h3>
        <p className="mt-1 text-sm text-slate-500">
          You manage this section as its Class Representative. Only an administrator can change CR assignment.
        </p>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Name</dt>
            <dd className="mt-0.5 text-sm font-medium text-slate-800">{user?.name ?? '—'}</dd>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Email</dt>
            <dd className="mt-0.5 break-all text-sm font-medium text-slate-800">{user?.email ?? '—'}</dd>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Account status</dt>
            <dd className="mt-0.5 text-sm font-medium text-emerald-700">{user?.registrationStatus ?? '—'}</dd>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Member since</dt>
            <dd className="mt-0.5 text-sm font-medium text-slate-800">{formatDate(user?.activationAt ?? null)}</dd>
          </div>
        </dl>
      </Card>

      <div className="flex items-start gap-3 rounded-2xl border border-primary-100 bg-primary-50/60 p-5 text-sm text-primary-900">
        <IconInfo className="mt-0.5 size-4 shrink-0 text-primary-600" />
        <p>
          Need a change? Departments, sessions and section assignment are managed by the administration.
          Your section data here always reflects what the server has assigned to your account.
        </p>
      </div>
    </div>
  );
}

export function SectionEmpty() {
  return (
    <EmptyState
      icon={<IconUsers className="size-10" />}
      title="No section assigned"
      description="An administrator needs to assign you to a section first."
    />
  );
}
