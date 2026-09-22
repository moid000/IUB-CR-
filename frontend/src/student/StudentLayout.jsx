import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useBodyScrollLock } from '../components/ui/useBodyScrollLock.js';
import { studentApi } from '../api/student.js';
import { SidebarBrand, NavGroup, NavItem } from '../components/layout/Sidebar.jsx';
import { BottomTabBar } from '../components/layout/BottomTabBar.jsx';
import { AccountMenu } from '../components/layout/AccountMenu.jsx';
import {
  IconGrid, IconBook, IconMegaphone, IconFileText, IconClipboard, IconCalendar,
  IconQr, IconCheckCircle, IconBell, IconMenu, IconGraduation, IconUserSquare,
  IconLogout,
} from '../components/icons.jsx';

/**
 * Student portal shell — mobile-first personal academic workspace.
 * Same design language as Admin/CR: grouped rail, pinned account area,
 * Motion drawer with scroll lock. Section context is ALWAYS server-derived.
 */

const EASE = [0.22, 1, 0.36, 1];

/**
 * Per-tab unread badges. Keys are exact tab paths; values are the notification
 * types that tab "owns". Visiting the page silently marks those unread rows
 * read (server: read-by-type) — the number disappears once the tab is seen,
 * exactly like the owner asked.
 */
const BADGE_TYPES_FOR_PATH = {
  '/student/announcements': ['announcement'],
  '/student/assignments': ['assignment', 'reminder'], // deadline reminders belong to Assignments
  '/student/timetable': ['timetable'],
};

const NAV_GROUPS = [
  {
    items: [{ to: '/student', label: 'Dashboard', icon: IconGrid, end: true }],
  },
  {
    label: 'Classroom',
    items: [
      { to: '/student/subjects', label: 'Subjects', icon: IconBook },
      { to: '/student/announcements', label: 'Announcements', icon: IconMegaphone },
      { to: '/student/notes', label: 'Notes', icon: IconFileText },
      { to: '/student/assignments', label: 'Assignments', icon: IconClipboard },
    ],
  },
  {
    label: 'Schedule',
    items: [
      { to: '/student/timetable', label: 'Timetable', icon: IconCalendar },
      { to: '/student/attendance', label: 'Attendance', icon: IconQr },
    ],
  },
  {
    label: 'Results',
    items: [{ to: '/student/marks', label: 'Marks', icon: IconCheckCircle }],
  },
];

function pageTitle(pathname) {
  const all = [...NAV_GROUPS.flatMap((g) => g.items), { to: '/student/notifications', label: 'Notifications' }, { to: '/student/profile', label: 'Profile' }];
  const match = all.find((n) => n.to !== '/student' && pathname.startsWith(n.to));
  return match ? match.label : 'Dashboard';
}

function SidebarBody({ section, unread, onNavigateMobile }) {
  return (
    <>
      <SidebarBrand to="/student" onClose={onNavigateMobile} />

      {section ? (
        <div className="border-b border-slate-100 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Your section</p>
          <p className="mt-0.5 truncate text-sm font-medium text-slate-800">
            {section.department?.code ? `${section.department.code} — ` : ''}{section.name}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {section.department?.name}{section.semester != null ? ` · Semester ${section.semester}` : ''}
          </p>
        </div>
      ) : null}

      <nav className="flex-1 space-y-3 overflow-y-auto p-3" aria-label="Student navigation">
        {NAV_GROUPS.map((group, i) => (
          <NavGroup key={group.label ?? i} label={group.label} items={group.items} />
        ))}
      </nav>

      {/* Pinned account area */}
      <div className="space-y-0.5 border-t border-slate-100 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <NavItem to="/student/notifications" label="Notifications" icon={IconBell} badge={unread} />
        <NavItem to="/student/profile" label="Profile" icon={IconUserSquare} />
      </div>
    </>
  );
}

export default function StudentLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unread, setUnread] = useState(null); // total — drawer Notifications badge
  const [unreadByType, setUnreadByType] = useState(null); // per-tab numbers

  const section = user?.section;

  // Close the mobile drawer on navigation
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useBodyScrollLock(drawerOpen);

  // Per-type unread counts — fetched once per navigation (lazy server reminders).
  // Landing on a tab page ALSO clears that tab's unread rows server-side, so
  // its number disappears as soon as the tab is opened and seen.
  useEffect(() => {
    let cancelled = false;
    const clearTypes = BADGE_TYPES_FOR_PATH[location.pathname];
    studentApi.notifications.unreadByType()
      .then((res) => {
        if (cancelled) return;
        const byType = res?.data?.byType ?? {};
        setUnread(res?.data?.total ?? 0);
        setUnreadByType(byType);
        if (clearTypes && clearTypes.some((t) => byType[t] > 0)) {
          studentApi.notifications.readByType(clearTypes)
            .then((r) => {
              if (cancelled) return;
              const cleared = r?.data?.count ?? 0;
              setUnreadByType((prev) => {
                const next = { ...prev };
                for (const t of clearTypes) delete next[t];
                return next;
              });
              setUnread((prev) => Math.max(0, (prev ?? 0) - cleared));
            })
            .catch(() => {}); // badge clear is best-effort
        }
      })
      .catch(() => {}); // badges are decorative — never block the shell
    return () => { cancelled = true; };
  }, [location.pathname]);

  // Per-tab badge number (sum of that tab's notification types)
  const tabBadge = (types) => {
    if (!unreadByType) return null;
    const n = types.reduce((sum, t) => sum + (unreadByType[t] ?? 0), 0);
    return n > 0 ? n : null;
  };

  const handleLogout = async () => {
    await logout(); // POST /api/auth/logout clears the httpOnly cookie
    navigate('/login');
  };

  const sectionLabel = section ? `${section.department?.name ?? ''} ${section.name}`.trim() : null;

  return (
    <div className="min-h-dvh bg-slate-50">
      {/* ---- Desktop sidebar rail ---- */}
      <aside
        className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-slate-200/80 bg-white lg:flex"
        aria-label="Student navigation"
      >
        <SidebarBody section={section} unread={unread} onNavigateMobile={null} />
      </aside>

      {/* ---- Mobile drawer ---- */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15, ease: EASE }}
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <motion.aside
              className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-slate-200 bg-white shadow-lift lg:hidden"
              initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
              transition={{ duration: 0.18, ease: EASE }}
              aria-label="Student navigation"
            >
              <SidebarBody section={section} unread={unread} onNavigateMobile={() => setDrawerOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ---- Main column ---- */}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white lg:bg-white/85 lg:backdrop-blur-md">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <button
              type="button" onClick={() => setDrawerOpen(true)} aria-label="Open navigation menu"
              className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 lg:hidden"
            >
              <IconMenu className="size-5" />
            </button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold tracking-tight text-slate-900 sm:text-lg">
                {pageTitle(location.pathname)}
              </h2>
              {sectionLabel && (
                <p className="truncate text-xs text-slate-500">{sectionLabel}</p>
              )}
            </div>
            <AccountMenu
              user={user}
              roleLabel="Student"
              roleVariant="primary"
              menuItems={[
                { to: '/student/profile', label: 'Profile', icon: IconUserSquare },
                { label: 'Sign out', icon: IconLogout, onClick: handleLogout, danger: true },
              ]}
            />
          </div>
        </header>

        <main className="px-4 pt-6 pb-28 sm:px-6 sm:pt-8 lg:px-8 lg:pb-8">
          <Outlet />
        </main>
      </div>

      {/* ---- Mobile bottom tab bar (drawer handles the rest) ---- */}
      <BottomTabBar
        items={[
          { to: '/student', label: 'Dashboard', icon: IconGrid, end: true },
          { to: '/student/announcements', label: 'Announcements', icon: IconMegaphone, badge: tabBadge(['announcement']) },
          { to: '/student/assignments', label: 'Assignments', icon: IconClipboard, badge: tabBadge(['assignment', 'reminder']) },
          { to: '/student/timetable', label: 'Timetable', icon: IconCalendar, badge: tabBadge(['timetable']) },
        ]}
      />
    </div>
  );
}
