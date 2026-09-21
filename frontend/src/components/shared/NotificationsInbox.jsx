import { Link } from 'react-router-dom';
import { IconBell, IconMegaphone, IconClipboard, IconCalendar, IconClock, IconCheck } from '../icons.jsx';
import { EmptyState } from '../ui/EmptyState.jsx';
import { timeAgo } from '../../admin/format.js';

/** Per-type icon + label for notification rows. */
export const TYPE_META = {
  announcement: { label: 'Announcement', Icon: IconMegaphone },
  assignment: { label: 'Assignment', Icon: IconClipboard },
  attendance: { label: 'Attendance', Icon: IconCheck },
  timetable: { label: 'Timetable', Icon: IconCalendar },
  reminder: { label: 'Reminder', Icon: IconClock },
};

/** Where a notification should take you when tapped, per portal base path. */
export function notifRoute(n, basePath) {
  const byType = {
    announcement: 'announcements',
    assignment: 'assignments',
    note: 'notes',
    timetable: 'timetable',
    reminder: 'timetable', // class-starting reminders point at the day's slot
    attendance: 'attendance',
    system: null,
  };
  const seg = byType[n.type];
  if (!seg) return null;
  const base = `${basePath}/${seg}`;
  const ref = n.refId ? String(n.refId) : null;
  return ref ? `${base}?focus=${ref}` : base;
}

/** Friendly day bucket for grouping: Today / Yesterday / "Sun 20 Sept". */
function dayLabel(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = startOfDay(new Date());
  const day = startOfDay(d);
  if (day === today) return 'Today';
  if (day === today - 86400000) return 'Yesterday';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

/** Segmented All / Unread control with a live unread count chip. */
export function NotificationFilterPills({ value, onChange, unreadCount }) {
  const pills = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
  ];
  return (
    <div
      role="group"
      aria-label="Notification filters"
      className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1"
    >
      {pills.map((p) => {
        const active = value === p.key;
        return (
          <button
            key={p.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(p.key)}
            className={`flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold transition-all duration-200
              ${active ? 'bg-primary-600 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
          >
            {p.label}
            {p.key === 'unread' && unreadCount > 0 && (
              <span
                className={`rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums
                  ${active ? 'bg-white/20 text-white' : 'bg-primary-100 text-primary-700'}`}
              >
                {unreadCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Row-shaped skeletons that match the real notification layout. */
export function NotificationsSkeleton({ rows = 6 }) {
  return (
    <div className="space-y-2.5" role="status" aria-label="Loading notifications">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 rounded-2xl border border-slate-100 bg-white p-3.5">
          <div className="size-9 shrink-0 rounded-lg skeleton-shimmer" />
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">
            <div className="h-3 w-2/3 rounded skeleton-shimmer" />
            <div className="h-2.5 w-full rounded skeleton-shimmer" />
            <div className="h-2 w-1/4 rounded skeleton-shimmer" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** One premium notification row — icon chip, day-aware accent, compact mark-read. */
export function NotificationRow({ n, onMarkRead, basePath }) {
  const meta = TYPE_META[n.type] ?? { label: n.type ?? 'Notice', Icon: IconBell };
  const unread = !n.read;
  const route = basePath ? notifRoute(n, basePath) : null;

  const markRead = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onMarkRead?.(n._id);
  };

  const body = (
    <div className="flex items-start gap-3 p-3.5 pl-4">
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-lg ring-1
          ${unread ? 'bg-white text-primary-600 ring-primary-100' : 'bg-slate-50 text-slate-400 ring-slate-200/70'}`}
      >
        <meta.Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className={`min-w-0 text-sm ${unread ? 'font-semibold text-slate-800' : 'font-medium text-slate-600'}`}>
            {n.title}
          </p>
          {unread && (
            <span className="mt-0.5 shrink-0 rounded-full bg-primary-600 px-1.5 py-px text-[9px] font-bold uppercase tracking-widest text-white">
              New
            </span>
          )}
        </div>
        {n.message && (
          <p className={`mt-0.5 line-clamp-2 text-[13px] leading-snug ${unread ? 'text-slate-600' : 'text-slate-400'}`}>
            {n.message}
          </p>
        )}
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          <span className={unread ? 'text-primary-500' : undefined}>{meta.label}</span>
          <span aria-hidden="true" className="text-slate-300">·</span>
          <span className="normal-case tracking-normal">{timeAgo(n.createdAt)}</span>
        </p>
      </div>
      {unread && onMarkRead && (
        <button
          type="button"
          aria-label={`Mark as read: ${n.title}`}
          title="Mark as read"
          onClick={markRead}
          className="grid size-8 shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 transition-all duration-200 hover:border-primary-200 hover:bg-primary-50 hover:text-primary-600 active:scale-95"
        >
          <IconCheck className="size-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <li
      className={`relative overflow-hidden rounded-2xl border transition-all duration-200
        ${unread
          ? 'border-primary-100 bg-primary-50/50 hover:border-primary-200'
          : 'border-slate-100 bg-white hover:border-slate-200 hover:bg-slate-50/60'}`}
    >
      {unread && (
        <span className="absolute inset-y-0 left-0 z-10 w-1 bg-gradient-to-b from-primary-400 to-primary-600" aria-hidden="true" />
      )}
      {route ? (
        <Link
          to={route}
          onClick={() => { if (unread) onMarkRead?.(n._id); }}
          aria-label={`Open ${meta.label.toLowerCase()}: ${n.title}`}
          className="block cursor-pointer focus-visible:outline-none"
        >
          {body}
        </Link>
      ) : body}
    </li>
  );
}

/** Day-grouped list: Today / Yesterday / dates as soft section dividers. */
export function NotificationsList({ items, onMarkRead, basePath }) {
  const groups = [];
  for (const n of items) {
    const label = dayLabel(n.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }

  return (
    <ul className="space-y-2.5">
      {groups.map((g) => (
        <li key={g.label} className="space-y-2">
          <div className="flex items-center gap-2 px-1 pt-1">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{g.label}</span>
            <span className="h-px flex-1 bg-slate-200/80" aria-hidden="true" />
          </div>
          <ul className="space-y-2">
            {g.items.map((n) => (
              <NotificationRow key={n._id} n={n} onMarkRead={onMarkRead} basePath={basePath} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** Calm empty inbox state. */
export function InboxEmpty({ unreadOnly }) {
  return (
    <EmptyState
      icon={<IconBell className="size-5" />}
      title={unreadOnly ? 'No unread notifications' : "You're all caught up"}
      description={
        unreadOnly
          ? 'Everything has been read — new updates will land here the moment they happen.'
          : 'Announcements, assignments and reminders from your section will show up here.'
      }
    />
  );
}
