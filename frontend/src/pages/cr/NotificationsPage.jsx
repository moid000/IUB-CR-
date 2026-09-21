import { useEffect, useState } from 'react';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { Button } from '../../components/ui/Button.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { PageHeader, SuccessFlash } from '../../components/admin/controls.jsx';
import { IconCheck } from '../../components/icons.jsx';
import {
  NotificationFilterPills,
  NotificationsSkeleton,
  NotificationsList,
  InboxEmpty,
} from '../../components/shared/NotificationsInbox.jsx';

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
      <PageHeader
        title="Notifications"
        description={unreadCount > 0 ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}.` : 'Updates for you and your section.'}
      >
        <Button variant="secondary" icon={IconCheck} onClick={markAllRead} loading={readAllBusy} disabled={!unreadCount}>
          Mark all read
        </Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <NotificationFilterPills
        value={filter}
        onChange={(v) => { setFilter(v); setPage(1); }}
        unreadCount={unreadCount ?? 0}
      />

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <NotificationsSkeleton rows={5} />
      ) : items.length === 0 ? (
        <InboxEmpty unreadOnly={filter === 'unread'} />
      ) : (
        <NotificationsList items={items} onMarkRead={markRead} />
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">
          <span className="tabular-nums">Page {pagination.page} of {pagination.totalPages}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="secondary" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}
