import { useEffect, useState } from 'react';
import { studentApi } from '../../api/student.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { timeAgo } from '../../admin/format.js';
import { PageHeader, SuccessFlash } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { IconCheck, IconBell } from '../../components/icons.jsx';

const TYPE_LABELS = {
  announcement: 'Announcement',
  assignment: 'Assignment',
  attendance: 'Attendance',
  timetable: 'Timetable',
  reminder: 'Reminder',
};

/** Student notifications — own mailbox only; recipients/expiry are server-owned. */
export default function StudentNotificationsPage() {
  const [filter, setFilter] = useState('all');
  const [readAllBusy, setReadAllBusy] = useState(false);
  const [flash, showFlash] = useFlash();

  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.notifications.list({
      unread: filter === 'unread' ? 'true' : undefined,
      page: 1, limit: 30,
    }),
    [filter]
  );

  const [unreadCount, setUnreadCount] = useState(null);
  const refreshCount = () => studentApi.notifications.unreadCount()
    .then((res) => setUnreadCount(res?.data?.count ?? 0)).catch(() => {});

  // Initial unread badge count (the backend also lazily generates due
  // reminders server-side on this call — no client polling needed)
  useEffect(() => { refreshCount(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const markRead = async (id) => {
    try {
      await studentApi.notifications.read(id);
      reload();
      refreshCount();
    } catch { /* handled by list reload */ }
  };

  const markAllRead = async () => {
    setReadAllBusy(true);
    try {
      await studentApi.notifications.readAll();
      reload();
      refreshCount();
      showFlash('All notifications marked as read.');
    } catch { /* friendly error via list state */ }
    finally { setReadAllBusy(false); }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Notifications"
        description={unreadCount != null ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}.` : 'Updates about your section.'}
      >
        <Button variant="secondary" icon={IconCheck} onClick={markAllRead} loading={readAllBusy} disabled={unreadCount === 0}>
          Mark all read
        </Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Notification filters">
        {['all', 'unread'].map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`h-8 rounded-lg px-3 text-xs font-medium capitalize transition-colors
              ${filter === f ? 'bg-primary-600 text-white shadow-sm' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
          >
            {f === 'all' ? 'All' : 'Unread only'}
          </button>
        ))}
      </div>

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <div className="space-y-3" role="status" aria-label="Loading notifications">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 skeleton-shimmer rounded-2xl border border-slate-200/60" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconBell className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">
            {filter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}
          </h3>
          <p className="mt-1 text-sm text-slate-500">Announcements, assignments and reminders from your section will show up here.</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {items.map((n) => (
            <li key={n._id}>
              <div className={`rounded-2xl border p-4 shadow-soft transition-colors ${n.readAt ? 'border-slate-200/80 bg-white' : 'border-primary-100 bg-primary-50/40'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={n.readAt ? 'neutral' : 'primary'}>{TYPE_LABELS[n.type] ?? n.type}</Badge>
                      {!n.readAt && <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-primary-600">Unread</span>}
                    </div>
                    <p className="mt-1.5 text-sm font-medium text-slate-800">{n.title}</p>
                    {n.message && <p className="mt-0.5 text-sm text-slate-600">{n.message}</p>}
                    <p className="mt-1 text-xs text-slate-400">{timeAgo(n.createdAt)}</p>
                  </div>
                  {!n.readAt && (
                    <Button variant="secondary" size="sm" onClick={() => markRead(n._id)}>
                      Mark read
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
