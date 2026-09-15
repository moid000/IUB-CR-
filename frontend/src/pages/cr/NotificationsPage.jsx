import { useEffect, useState } from 'react';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { formatDateTime, timeAgo } from '../../admin/format.js';
import { Button } from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { PageHeader, FilterBar, FilterSelect, ConfirmDialog, SuccessFlash } from '../../components/admin/controls.jsx';
import { IconBell, IconCheck, IconInbox } from '../../components/icons.jsx';

const TYPE_LABELS = {
  announcement: 'Announcement',
  assignment: 'Assignment',
  attendance: 'Attendance',
  timetable: 'Timetable',
  reminder: 'Reminder',
};

/**
 * CR notifications — the CR's own mailbox only. Recipients, dedupe keys and
 * expiry are server-owned; the CR can only mark read / read-all.
 */
export default function NotificationsPage() {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [readAllBusy, setReadAllBusy] = useState(false);
  const [flash, showFlash] = useFlash();

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => crApi.notifications.list({
      unread: filter === 'unread' ? 'true' : undefined,
      page, limit: 20,
    }),
    [filter, page]
  );

  const [unreadCount, setUnreadCount] = useState(null);
  const refreshCount = () => crApi.notifications.unreadCount()
    .then((res) => setUnreadCount(res?.data?.count ?? 0)).catch(() => {});

  // Initial unread badge count (the backend also lazily generates due
  // reminders server-side on this call — no client polling needed)
  useEffect(() => { refreshCount(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const markRead = async (id) => {
    try {
      await crApi.notifications.read(id);
      reload();
      refreshCount();
    } catch { /* handled by list reload */ }
  };

  const markAllRead = async () => {
    setReadAllBusy(true);
    try {
      await crApi.notifications.readAll();
      reload();
      refreshCount();
      showFlash('All notifications marked as read.');
    } catch { /* friendly error via list state */ }
    finally { setReadAllBusy(false); }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Notifications" description={unreadCount != null ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}.` : 'Updates for you and your section.'}>
        <Button variant="secondary" icon={IconCheck} onClick={markAllRead} loading={readAllBusy} disabled={unreadCount === 0}>
          Mark all read
        </Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <FilterSelect label="Filter" value={filter} onChange={(v) => { setFilter(v); setPage(1); }}>
          <option value="all">All</option>
          <option value="unread">Unread only</option>
        </FilterSelect>
      </FilterBar>

      {error ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft">
          <p className="text-sm font-medium text-red-600">{error.message}</p>
          <div className="mt-3"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </div>
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 skeleton-shimmer rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft">
          <div className="flex flex-col items-center py-10 text-center">
            <IconInbox className="size-10 text-slate-300" />
            <h3 className="mt-3 text-sm font-semibold text-slate-700">You're all caught up</h3>
            <p className="mt-1 max-w-sm text-sm text-slate-500">No notifications here — announcements you publish also notify your section automatically.</p>
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li
              key={n._id}
              className={`rounded-2xl border p-4 shadow-soft transition-colors
                ${n.read ? 'border-slate-200/80 bg-white' : 'border-primary-100 bg-primary-50/50'}`}
            >
              <div className="flex items-start gap-3">
                <IconBell className={`mt-0.5 size-4 shrink-0 ${n.read ? 'text-slate-400' : 'text-primary-600'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className={`text-sm ${n.read ? 'font-medium text-slate-700' : 'font-semibold text-slate-900'}`}>{n.title}</p>
                    {!n.read && <span className="rounded-full bg-primary-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">New</span>}
                    {n.type && <Badge variant="gray">{TYPE_LABELS[n.type] ?? n.type}</Badge>}
                  </div>
                  {n.message && <p className="mt-0.5 text-sm text-slate-600">{n.message}</p>}
                  <p className="mt-1 text-xs text-slate-400">{formatDateTime(n.createdAt)} PKT · {timeAgo(n.createdAt)}</p>
                </div>
                {!n.read && (
                  <Button variant="ghost" size="sm" className="shrink-0" onClick={() => markRead(n._id)}>Mark read</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>Page {pagination.page} of {pagination.totalPages}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="secondary" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}
