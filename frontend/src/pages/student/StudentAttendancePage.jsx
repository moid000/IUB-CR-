import { useEffect, useState } from 'react';
import { SkeletonRows } from '../../components/ui/Skeleton.jsx';
import { studentApi } from '../../api/student.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { formatDateTimeNoYear, timeAgo } from '../../admin/format.js';
import { PageHeader } from '../../components/admin/controls.jsx';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import { IconQr, IconClock } from '../../components/icons.jsx';

/**
 * Student attendance — codes and the QR payload are CR-generated; the backend
 * alone verifies session, expiry, code, section and duplicates. The frontend
 * NEVER generates a code or trusts QR contents client-side.
 */
export default function StudentAttendancePage() {
  const { user } = useAuth();
  const section = user?.section;
  const [sessions, setSessions] = useState(null); // null = loading
  const [sessionsError, setSessionsError] = useState(null);
  const [attendedIds, setAttendedIds] = useState(new Set());
  const [code, setCode] = useState('');
  const [qrToken, setQrToken] = useState('');
  const [marking, setMarking] = useState(false);
  const [message, setMessage] = useState(null); // { type: 'success'|'error', text }

  const history = useAdminQuery(
    () => studentApi.attendance.history({ page: 1, limit: 20 }),
    []
  );

  const loadActive = () => {
    setSessions(null);
    setSessionsError(null);
    Promise.all([
      studentApi.attendance.activeSessions().catch(() => null),
      // own records — to show "Attended" against active sessions
      studentApi.attendance.history({ limit: 50 }).catch(() => null),
    ]).then(([active, records]) => {
      if (!active) { setSessions([]); return; }
      setSessions(active?.data ?? []);
      setAttendedIds(new Set((records?.data ?? []).map((r) => String(r.session?._id))));
    }).catch((err) => {
      setSessions([]);
      setSessionsError(err);
    });
  };

  useEffect(() => { if (section) loadActive(); }, [section]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!section) return <NoSection />;

  const markWithCode = async (sessionId) => {
    if (!code.trim()) {
      setMessage({ type: 'error', text: 'Enter the attendance code from your CR.' });
      return;
    }
    setMarking(true);
    setMessage(null);
    try {
      const res = await studentApi.attendance.attendWithCode(sessionId, code.trim());
      const subj = res?.data?.session?.subject;
      setMessage({ type: 'success', text: `Attendance marked${subj?.name ? ` for ${subj.name}` : ''}.` });
      setCode('');
      loadActive();
      history.reload();
    } catch (err) {
      setMessage({ type: 'error', text: friendlyAttendanceError(err) });
    } finally {
      setMarking(false);
    }
  };

  const markWithQr = async () => {
    if (!qrToken.trim()) {
      setMessage({ type: 'error', text: 'Paste the QR text you scanned.' });
      return;
    }
    setMarking(true);
    setMessage(null);
    try {
      const res = await studentApi.attendance.scanQr(qrToken.trim());
      const subj = res?.data?.session?.subject;
      setMessage({ type: 'success', text: `Attendance marked${subj?.name ? ` for ${subj.name}` : ''}.` });
      setQrToken('');
      loadActive();
      history.reload();
    } catch (err) {
      setMessage({ type: 'error', text: friendlyAttendanceError(err) });
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Attendance"
        description={`Mark yourself present with the code your CR shares in class. Section ${section.name}.`}
      />

      {message && (
        <Alert variant={message.type === 'success' ? 'success' : 'danger'} role="status">
          <p className="font-medium">{message.text}</p>
        </Alert>
      )}

      {/* ---- Active sessions ---- */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Mark attendance now</h3>
          <button type="button" onClick={loadActive} className="text-xs font-medium text-primary-600 hover:text-primary-700">
            Refresh
          </button>
        </div>

        {sessionsError ? (
          <Alert variant="danger" className="mt-3"><p className="font-medium">{sessionsError.message}</p></Alert>
        ) : sessions == null ? (
          <SkeletonRows rows={2} circle={false} />
        ) : sessions.length === 0 ? (
          <p className="mt-3 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            No active attendance sessions right now. Ask your CR to start one.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {sessions.map((s) => {
              const attended = attendedIds.has(String(s._id));
              return (
                <div key={s._id} className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{s.subject?.name ?? 'Session'}</p>
                      <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-slate-500">
                        <IconClock className="size-3.5" />Open until {formatDateTimeNoYear(s.expiresAt)}
                      </p>
                    </div>
                    {attended && <Badge variant="success">Attended</Badge>}
                  </div>
                  {!attended && (
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <label htmlFor={`code-${s._id}`} className="sr-only">Attendance code for {s.subject?.name ?? 'session'}</label>
                      <input
                        id={`code-${s._id}`}
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder="Enter the code"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        disabled={marking}
                        className="h-10 flex-1 rounded-lg border border-slate-200 bg-white px-3.5 text-sm font-medium tracking-widest text-slate-800 placeholder:tracking-normal placeholder:text-slate-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
                      />
                      <Button onClick={() => markWithCode(s._id)} loading={marking}>Mark present</Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ---- QR token fallback (scan with any camera app, paste the text) ---- */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          <label htmlFor="qr-token" className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Scanned a QR? Paste its text here
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id="qr-token"
              type="text"
              placeholder="Paste the QR text…"
              value={qrToken}
              onChange={(e) => setQrToken(e.target.value)}
              disabled={marking}
              className="h-10 flex-1 rounded-lg border border-slate-200 bg-white px-3.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
            <Button variant="secondary" icon={IconQr} onClick={markWithQr} loading={marking}>Verify &amp; mark</Button>
          </div>
          <p className="mt-1.5 text-xs text-slate-400">
            The server verifies the signed QR — nothing is trusted on your device.
          </p>
        </div>
      </Card>

      {/* ---- History ---- */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-slate-900">My attendance history</h3>
        <DataTable
          columns={[
            { key: 'subject', header: 'Subject', render: (r) => <span className="font-medium text-slate-800">{r.session?.subject?.name ?? '—'}</span> },
            { key: 'date', header: 'Session date', render: (r) => r.session?.date ?? '—' },
            { key: 'markedAt', header: 'Marked', render: (r) => timeAgo(r.markedAt) },
            { key: 'method', header: 'Method', className: 'hidden sm:table-cell' },
            { key: 'status', header: 'Status', render: (r) => <Badge variant={r.status === 'present' ? 'success' : 'neutral'}>{r.status}</Badge> },
          ]}
          rows={history.items}
          loading={history.loading}
          error={history.error}
          onRetry={history.reload}
          emptyTitle="No attendance records yet."
          emptyDescription="Once you mark attendance in class, your history appears here."
        />
      </div>
    </div>
  );
}

/** Maps backend attendance errors to clear classroom-friendly states. */
function friendlyAttendanceError(err) {
  const msg = err?.message ?? '';
  if (err?.status === 409) return 'You have already marked attendance for this session.';
  if (err?.status === 404) return "That attendance session doesn't exist (or has ended).";
  if (/invalid code/i.test(msg)) return 'Invalid attendance code. Check with your CR and try again.';
  if (/no longer active/i.test(msg)) return 'This session has expired — ask your CR to start a new one.';
  return msg || 'Something went wrong. Please try again.';
}
