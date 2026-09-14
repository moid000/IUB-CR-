import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { formatDate } from '../../admin/format.js';
import { IconLogout, IconBuilding, IconLayers, IconCalendar, IconGraduation, IconInfo } from '../../components/icons.jsx';

/**
 * CR profile — SAFE data only from /api/auth/me (name, email, role, section
 * context). Never displays password/OTP/token data (the backend projection
 * already excludes them). Logout POSTs /api/auth/logout then redirects.
 */
export default function CrProfilePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      await logout(); // clears the httpOnly cookie server-side
    } finally {
      navigate('/login');
    }
  };

  const section = user?.section;

  const rows = [
    { icon: IconGraduation, label: 'Full name', value: user?.name ?? '—' },
    { icon: IconBuilding, label: 'Email', value: user?.email ?? '—' },
    { icon: IconCalendar, label: 'Phone', value: user?.phone || 'Not provided' },
    { icon: IconLayers, label: 'Roll number', value: user?.rollNo || 'Not assigned' },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft sm:p-8">
        <div className="flex flex-wrap items-center gap-4">
          <span className="grid size-14 place-items-center rounded-2xl bg-primary-600 text-xl font-semibold text-white" aria-hidden="true">
            {(user?.name ?? 'C').slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">{user?.name}</h2>
            <p className="text-sm text-slate-500">{user?.email}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge variant="primary">Class Representative</Badge>
              <Badge variant={user?.registrationStatus === 'active' ? 'success' : 'warning'}>{user?.registrationStatus ?? 'unknown'}</Badge>
            </div>
          </div>
        </div>

        <dl className="mt-6 grid gap-3 sm:grid-cols-2">
          {rows.map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
              <Icon className="mt-0.5 size-4 shrink-0 text-primary-500" />
              <div className="min-w-0">
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
                <dd className="mt-0.5 break-all text-sm font-medium text-slate-800">{value}</dd>
              </div>
            </div>
          ))}
        </dl>
      </div>

      {section ? (
        <Card className="p-6 sm:p-8">
          <h3 className="text-sm font-semibold text-slate-900">Assigned section</h3>
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Section</dt>
              <dd className="mt-0.5 text-sm font-medium text-slate-800">{section.name}</dd>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Department</dt>
              <dd className="mt-0.5 text-sm font-medium text-slate-800">{section.department?.name ?? '—'}</dd>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Semester</dt>
              <dd className="mt-0.5 text-sm font-medium text-slate-800">{section.semester != null ? `Semester ${section.semester}` : '—'}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-slate-400">
            Member since {formatDate(user?.activationAt ?? user?.createdAt ?? null)} · Section status: {section.status}
          </p>
        </Card>
      ) : (
        <div className="flex items-start gap-3 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft">
          <IconInfo className="mt-0.5 size-4 shrink-0 text-slate-400" />
          <p className="text-sm text-slate-500">No section is assigned to you yet. An administrator assigns CRs to sections.</p>
        </div>
      )}

      <Card className="flex flex-wrap items-center justify-between gap-3 p-6">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Sign out</h3>
          <p className="mt-0.5 text-sm text-slate-500">Ends your session on this device.</p>
        </div>
        <Button variant="danger" icon={IconLogout} onClick={signOut} loading={busy}>Sign out</Button>
      </Card>
    </div>
  );
}
