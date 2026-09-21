import { useEffect, useState } from 'react';
import { studentApi } from '../../api/student.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { PageHeader, SuccessFlash } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { IconCheck } from '../../components/icons.jsx';
import {
  NotificationFilterPills,
  NotificationsSkeleton,
  NotificationsList,
  InboxEmpty,
} from '../../components/shared/NotificationsInbox.jsx';

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
        description={unreadCount > 0 ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}.` : 'Updates about your section.'}
      >
        <Button variant="secondary" icon={IconCheck} onClick={markAllRead} loading={readAllBusy} disabled={!unreadCount}>
          Mark all read
        </Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <NotificationFilterPills value={filter} onChange={setFilter} unreadCount={unreadCount ?? 0} />

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <NotificationsSkeleton />
      ) : items.length === 0 ? (
        <InboxEmpty unreadOnly={filter === 'unread'} />
      ) : (
        <NotificationsList items={items} onMarkRead={markRead} basePath="/student" />
      )}
    </div>
  );
}
