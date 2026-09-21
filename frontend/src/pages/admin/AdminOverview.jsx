import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext.jsx';
import { adminApi } from '../../api/admin.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { timeAgo } from '../../admin/format.js';
import { CountUp } from '../../components/ui/CountUp.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { ConfirmDialog } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import {
  IconBuilding, IconCalendar, IconLayers, IconUserSquare, IconGraduation, IconBook,
  IconPlus, IconUserPlus, IconArrowRight, IconAlert, IconTrash,
} from '../../components/icons.jsx';

/** One metric card — real API counts only, never invented statistics. */
function MetricCard({ icon: Icon, label, value, sub, to }) {
  return (
    <Link
      to={to}
      className="group block rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft transition-all hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-lift"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-600 transition-all duration-300 group-hover:scale-110 group-hover:bg-primary-100">
        <Icon className="size-4.5 transition-transform duration-300 group-hover:-rotate-6" />
      </span>
      <p className="mt-2.5 text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
        {value === '' || value === null || value === undefined ? '' : <CountUp value={value} />}
      </p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary-600 opacity-0 transition-all duration-300 group-hover:translate-x-0.5 group-hover:opacity-100">
        Manage <IconArrowRight className="size-3 transition-transform duration-300 group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

export default function AdminOverview() {
  const { user } = useAuth();
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeText, setWipeText] = useState('');
  const [wipeBusy, setWipeBusy] = useState(false);
  const [wipeError, setWipeError] = useState(null);
  const [wipeDone, setWipeDone] = useState(null);

  // Real data only — unpaginated reference lists + count-only paginated calls
  const { items: departments, loading: ld, error: ed } = useAdminQuery(() => adminApi.departments.list({}), []);
  const { items: sessions, loading: ls, error: es } = useAdminQuery(() => adminApi.sessions.list({}), []);
  const { items: sections, loading: lsec, error: esec } = useAdminQuery(() => adminApi.sections.list({}), []);
  const { items: crs, pagination: crsPage, loading: lcr } = useAdminQuery(() => adminApi.crs.list({ limit: 100 }), []);
  const { pagination: studentsPage, loading: lstu } = useAdminQuery(() => adminApi.students.list({ limit: 1 }), []);
  const { pagination: subjectsPage, loading: lsub } = useAdminQuery(() => adminApi.subjects.list({ limit: 1 }), []);

  const activeSession = sessions.find((s) => s.status === 'active');
  const activeSections = sections.filter((s) => s.status === 'active');
  const pendingCrs = crs.filter((c) => c.registrationStatus === 'pending');
  const unassignedCrs = crs.filter((c) => !(c.section?._id ?? c.section));

  const confirmWipe = async () => {
    if (wipeText.trim() !== 'DELETE') return;
    setWipeBusy(true); setWipeError(null);
    try {
      const res = await adminApi.system.wipeAll();
      setWipeDone(res?.deleted ?? {});
      setWipeOpen(false);
      setWipeText('');
      // Give the admin a moment to read the summary, then refresh all counts.
      setTimeout(() => window.location.reload(), 2600);
    } catch (err) {
      setWipeError(err);
    } finally {
      setWipeBusy(false);
    }
  };

  const cards = [
    {
      icon: IconBuilding, label: 'Departments', to: '/admin/departments',
      value: ld ? null : departments.length,
      sub: ld ? null : `${departments.filter((d) => d.status === 'active').length} active`,
    },
    {
      icon: IconCalendar, label: 'Academic Sessions', to: '/admin/sessions',
      value: ls ? null : sessions.length,
      sub: ls ? null : (activeSession ? `Current: ${activeSession.name}` : 'No active session'),
    },
    {
      icon: IconLayers, label: 'Sections', to: '/admin/sections',
      value: lsec ? null : sections.length,
      sub: lsec ? null : `${activeSections.length} active`,
    },
    {
      icon: IconUserSquare, label: 'CRs & GRs', to: '/admin/crs',
      value: lcr ? null : (crsPage ? crsPage.total : crs.length),
      sub: lcr ? null : `${pendingCrs.length} pending activation${unassignedCrs.length ? ` · ${unassignedCrs.length} unassigned` : ''}`,
    },
    {
      icon: IconGraduation, label: 'Students', to: '/admin/students',
      value: lstu ? null : (studentsPage ? studentsPage.total : '—'),
      sub: lstu ? null : 'Across all sections',
    },
    {
      icon: IconBook, label: 'Subjects', to: '/admin/subjects',
      value: lsub ? null : (subjectsPage ? subjectsPage.total : '—'),
      sub: lsub ? null : 'Active courses across sections',
    },
  ];

  const loading = ld || ls || lsec;
  const recentSections = sections.slice(0, 5);
  const firstName = (user?.name ?? user?.email ?? 'Administrator').split(' ')[0];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Welcome back, {firstName}</h1>
          <p className="mt-1 text-sm text-slate-500">Academic management overview — departments, sessions, sections and people.</p>
        </div>
      </div>

      {!ls && !activeSession && sessions.length >= 0 && (
        <Alert variant="warning" className="mb-4">
          No academic session is currently active. Sections (and everything under them) need an active session —{' '}
          <Link to="/admin/sessions" className="font-medium underline underline-offset-2">set one up</Link>.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        {cards.map((c) => (
          <div><MetricCard
            key={c.label}
            icon={c.icon}
            label={c.label}
            to={c.to}
            value={c.value === null || c.value === undefined || c.value === null ? '' : c.value}
            sub={c.sub}
          /></div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Recent sections — real data, newest first (backend sort) */}
        <section aria-label="Recent sections" className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft lg:col-span-3">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">Recent sections</h2>
            <Link to="/admin/sections" className="text-xs font-medium text-primary-600 hover:text-primary-700">View all →</Link>
          </div>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
            </div>
          ) : recentSections.length === 0 ? (
            <p className="py-4 text-sm text-slate-500">No sections yet. Create a department and a session first, then add a section.</p>
          ) : (
            <ul className="divide-y divide-slate-100" role="list">
              {recentSections.map((s) => (
                <li key={s._id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {s.name}
                      <span className="ml-2 text-xs font-normal text-slate-500">{s.department?.name} · Sem {s.semester}</span>
                    </p>
                    <p className="truncate text-xs text-slate-400">{s.session?.name} · created {timeAgo(s.createdAt)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {s.cr
                      ? <Badge variant="primary">CR: {s.cr.name}</Badge>
                      : <Badge variant="warning">No CR</Badge>}
                    {s.gr && <Badge variant="neutral">GR: {s.gr.name}</Badge>}
                    <StatusBadge status={s.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Quick actions */}
        <section aria-label="Quick actions" className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-slate-800">Quick actions</h2>
          <div className="space-y-2.5">
            <Link to="/admin/departments" className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 transition-colors hover:border-primary-200 hover:bg-primary-50/40">
              <span className="grid size-8 place-items-center rounded-lg bg-primary-50 text-primary-600"><IconPlus className="size-4" /></span>
              New department
            </Link>
            <Link to="/admin/crs" className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 transition-colors hover:border-primary-200 hover:bg-primary-50/40">
              <span className="grid size-8 place-items-center rounded-lg bg-primary-50 text-primary-600"><IconUserPlus className="size-4" /></span>
              Pre-create a CR / GR account
            </Link>
            <Link to="/admin/sections" className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 transition-colors hover:border-primary-200 hover:bg-primary-50/40">
              <span className="grid size-8 place-items-center rounded-lg bg-primary-50 text-primary-600"><IconLayers className="size-4" /></span>
              Create a section
            </Link>
            <Link to="/admin/subjects" className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 transition-colors hover:border-primary-200 hover:bg-primary-50/40">
              <span className="grid size-8 place-items-center rounded-lg bg-primary-50 text-primary-600"><IconBook className="size-4" /></span>
              Add a subject
            </Link>
          </div>
          {wipeDone && (
            <Alert variant="success" className="mt-4">
              System wiped — {Object.entries(wipeDone).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing to delete'}.
              Reloading…
            </Alert>
          )}
          {pendingCrs.length > 0 && (
            <Alert variant="warning" className="mt-4">
              <p className="flex items-start gap-2">
                <IconAlert className="mt-0.5 size-4 shrink-0" />
                {pendingCrs.length} representative {pendingCrs.length === 1 ? 'account is' : 'accounts are'} awaiting activation.
                They activate themselves via the email OTP.
              </p>
            </Alert>
          )}
        </section>
      </div>

      {/* Danger zone — full system wipe */}
      <section
        aria-label="Danger zone"
        className="mt-6 rounded-2xl border border-red-200 bg-red-50/40 p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-red-100 text-red-600">
              <IconTrash className="size-4.5" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-red-800">Danger zone — Delete all data</h2>
              <p className="mt-1 max-w-2xl text-xs text-red-700/80">
                Permanently deletes every department, session, section, subject, CR and student account
                (with all their announcements, assignments, notes, marks, timetable and files).
                Only admin accounts and audit logs survive. This cannot be undone.
              </p>
            </div>
          </div>
          <Button variant="danger" onClick={() => { setWipeOpen(true); setWipeText(''); setWipeError(null); }}>
            Delete all data
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={wipeOpen}
        onClose={() => { if (!wipeBusy) { setWipeOpen(false); setWipeText(''); } }}
        title="Delete EVERYTHING?"
        confirmLabel="Yes, delete everything"
        onConfirm={confirmWipe}
        busy={wipeBusy}
        error={wipeError}
        danger
        disabled={wipeText.trim() !== 'DELETE'}
        body={
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              This removes <span className="font-medium text-slate-800">all departments, sessions, sections, subjects,
              CR and student accounts</span> and every piece of content they own. Uploaded files are also deleted
              from cloud storage. Your admin account stays.
            </p>
            <label className="block text-sm font-medium text-slate-700" htmlFor="wipe-confirm">
              Type <span className="font-bold tracking-widest text-red-600">DELETE</span> to confirm
            </label>
            <Input
              id="wipe-confirm"
              value={wipeText}
              onChange={(e) => setWipeText(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
              disabled={wipeBusy}
            />
          </div>
        }
      />
    </>
  );
}
