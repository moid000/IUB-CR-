import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { PageTransition } from '../components/motion/primitives.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { useBodyScrollLock } from '../components/ui/useBodyScrollLock.js';
import { crApi } from '../api/cr.js';
import { Badge } from '../components/ui/Badge.jsx';
import { SidebarBrand, NavGroup, NavItem } from '../components/layout/Sidebar.jsx';
import { AccountMenu } from '../components/layout/AccountMenu.jsx';
import {
  IconGrid, IconLayers, IconUsers, IconBook, IconMegaphone, IconFileText,
  IconClipboard, IconCalendar, IconQr, IconCheckCircle, IconBell, IconMenu,
  IconGraduation, IconUserSquare, IconLogout,
} from '../components/icons.jsx';

/**
 * CR shell — class operations cockpit.
 * Desktop: grouped rail with section context + pinned account area.
 * Mobile: Motion drawer with scroll lock and safe-area padding.
 */

const EASE = [0.22, 1, 0.36, 1];

const NAV_GROUPS = [
  {
    items: [{ to: '/cr', label: 'Dashboard', icon: IconGrid, end: true }],
  },
  {
    label: 'Class setup',
    items: [
      { to: '/cr/section', label: 'My Section', icon: IconLayers },
      { to: '/cr/students', label: 'Students', icon: IconUsers },
      { to: '/cr/subjects', label: 'Subjects', icon: IconBook },
    ],
  },
  {
    label: 'Daily operations',
    items: [
      { to: '/cr/announcements', label: 'Announcements', icon: IconMegaphone },
      { to: '/cr/notes', label: 'Notes', icon: IconFileText },
      { to: '/cr/assignments', label: 'Assignments', icon: IconClipboard },
      { to: '/cr/timetable', label: 'Timetable', icon: IconCalendar },
      { to: '/cr/attendance', label: 'Attendance', icon: IconQr },
    ],
  },
  {
    label: 'Results',
    items: [{ to: '/cr/marks', label: 'Marks', icon: IconCheckCircle }],
  },
];

function pageTitle(pathname) {
  const all = [...NAV_GROUPS.flatMap((g) => g.items), { to: '/cr/notifications', label: 'Notifications' }, { to: '/cr/profile', label: 'Profile' }];
  const match = all.find((n) => n.to !== '/cr' && pathname.startsWith(n.to));
  return match ? match.label : 'Dashboard';
}

function SidebarBody({ section, unread, onNavigateMobile }) {
  return (
    <>
      <SidebarBrand to="/cr" onClose={onNavigateMobile} IconBrand={IconGraduation} />

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
      ) : (
        <div className="border-b border-slate-100 px-4 py-3">
          <Badge variant="neutral">No section assigned</Badge>
        </div>
      )}

      <nav className="flex-1 space-y-3 overflow-y-auto p-3" aria-label="CR navigation">
        {NAV_GROUPS.map((group, i) => (
          <NavGroup key={group.label ?? i} label={group.label} items={group.items} />
        ))}
      </nav>

      {/* Pinned account area — always reachable, even in long sections */}
      <div className="space-y-0.5 border-t border-slate-100 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <NavItem to="/cr/notifications" label="Notifications" icon={IconBell} badge={unread} />
        <NavItem to="/cr/profile" label="Profile" icon={IconUserSquare} />
      </div>
    </>
  );
}

export default function CrLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unread, setUnread] = useState(null);

  const section = user?.section;

  // Close the mobile drawer on navigation
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useBodyScrollLock(drawerOpen);

  // Unread notification count — fetched once per navigation (lazy server reminders)
  useEffect(() => {
    let cancelled = false;
    crApi.notifications.unreadCount()
      .then((res) => { if (!cancelled) setUnread(res?.data?.count ?? 0); })
      .catch(() => {}); // badge is decorative — never block the shell
    return () => { cancelled = true; };
  }, [location.pathname]);

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
        aria-label="CR navigation"
      >
        <SidebarBody section={section} unread={unread} onNavigateMobile={null} />
      </aside>

      {/* ---- Mobile drawer ---- */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-sm lg:hidden"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE }}
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <motion.aside
              className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-slate-200 bg-white shadow-lift lg:hidden"
              initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
              transition={{ duration: 0.28, ease: EASE }}
              aria-label="CR navigation"
            >
              <SidebarBody section={section} unread={unread} onNavigateMobile={() => setDrawerOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ---- Main column ---- */}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur-md">
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
              roleLabel="Class Representative"
              roleVariant="primary"
              menuItems={[
                { to: '/cr/profile', label: 'Profile', icon: IconUserSquare },
                { label: 'Sign out', icon: IconLogout, onClick: handleLogout, danger: true },
              ]}
            />
          </div>
        </header>

        <main className="px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          <PageTransition key={location.pathname}>
            <Outlet />
          </PageTransition>
        </main>
      </div>
    </div>
  );
}
