import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { PageTransition } from '../components/motion/primitives.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { useBodyScrollLock } from '../components/ui/useBodyScrollLock.js';
import { SidebarBrand, NavGroup } from '../components/layout/Sidebar.jsx';
import { BottomTabBar } from '../components/layout/BottomTabBar.jsx';
import { AccountMenu } from '../components/layout/AccountMenu.jsx';
import {
  IconGrid, IconBuilding, IconCalendar, IconLayers, IconUserSquare,
  IconGraduation, IconBook, IconMenu, IconLogout, IconChevronsLeft,
} from '../components/icons.jsx';

/**
 * Admin shell — management control center.
 * Desktop: grouped sidebar with collapse. Mobile: Motion drawer with
 * scroll lock. Same design language as the CR/Student shells.
 */

const EASE = [0.22, 1, 0.36, 1];

const NAV_GROUPS = [
  {
    items: [{ to: '/admin', label: 'Overview', icon: IconGrid, end: true }],
  },
  {
    label: 'Academics',
    items: [
      { to: '/admin/departments', label: 'Departments', icon: IconBuilding },
      { to: '/admin/sessions', label: 'Academic Sessions', icon: IconCalendar },
      { to: '/admin/sections', label: 'Sections', icon: IconLayers },
      { to: '/admin/subjects', label: 'Subjects', icon: IconBook },
    ],
  },
  {
    label: 'People',
    items: [
      { to: '/admin/crs', label: 'Class Reps (CR & GR)', icon: IconUserSquare },
      { to: '/admin/students', label: 'Students', icon: IconGraduation },
    ],
  },
];

const ALL_NAV = NAV_GROUPS.flatMap((g) => g.items);

function pageTitle(pathname) {
  if (pathname === '/admin') return 'Overview';
  const match = ALL_NAV.find((n) => n.to !== '/admin' && pathname.startsWith(n.to));
  return match ? match.label : 'Admin';
}

const COLLAPSE_KEY = 'iubcr-admin-sidebar-collapsed';

function SidebarBody({ collapsed = false, onNavigateMobile, onToggleCollapse }) {
  return (
    <>
      <SidebarBrand to="/admin" onClose={onNavigateMobile} showTitle={!collapsed} />
      <nav className="flex-1 space-y-3 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" aria-label="Admin navigation">
        {NAV_GROUPS.map((group, i) => (
          <NavGroup key={group.label ?? i} label={group.label} items={group.items} collapsed={collapsed} />
        ))}
      </nav>
      <div className="hidden border-t border-slate-100 p-3 lg:block">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 ${collapsed ? 'justify-center px-2.5' : ''}`}
        >
          <IconChevronsLeft className={`size-4.5 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
          <span className={collapsed ? 'hidden' : ''}>Collapse</span>
        </button>
      </div>
    </>
  );
}

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the mobile drawer on navigation
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useBodyScrollLock(drawerOpen);

  const toggleCollapse = () => setCollapsed((c) => {
    localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
    return !c;
  });

  const handleLogout = async () => {
    await logout(); // POST /api/auth/logout clears the httpOnly cookie
    navigate('/login');
  };

  const title = pageTitle(location.pathname);

  const sidebarBodyProps = {};

  return (
    <div className="min-h-dvh bg-slate-50">
      {/* ---- Desktop sidebar rail ---- */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-slate-200/80 bg-white transition-[width] duration-200 lg:flex
          ${collapsed ? 'w-[76px]' : 'w-64'}`}
        aria-label="Admin navigation"
      >
        <SidebarBody collapsed={collapsed} onToggleCollapse={toggleCollapse} {...sidebarBodyProps} />
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
              aria-label="Admin navigation"
            >
              <SidebarBody onNavigateMobile={() => setDrawerOpen(false)} onToggleCollapse={null} {...sidebarBodyProps} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ---- Main column ---- */}
      <div className={`flex min-h-dvh flex-col transition-[padding] duration-200 ${collapsed ? 'lg:pl-[76px]' : 'lg:pl-64'}`}>
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200/70 bg-white/80 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 lg:hidden"
          >
            <IconMenu className="size-5" />
          </button>
          <h2 className="truncate text-base font-semibold tracking-tight text-slate-900 sm:text-lg">{title}</h2>

          <div className="ml-auto">
            <AccountMenu
              user={user}
              roleLabel="Administrator"
              roleVariant="primary"
              menuItems={[{ label: 'Sign out', icon: IconLogout, onClick: handleLogout, danger: true }]}
            />
          </div>
        </header>

        <main className="flex-1 px-4 pt-4 pb-28 sm:px-6 sm:pt-6 lg:p-8">
          <div className="mx-auto w-full max-w-6xl">
            <PageTransition key={location.pathname}>
              <Outlet />
            </PageTransition>
          </div>
        </main>
      </div>

      {/* ---- Mobile bottom tab bar (drawer handles the rest) ---- */}
      <BottomTabBar
        items={[
          { to: '/admin', label: 'Overview', icon: IconGrid, end: true },
          { to: '/admin/sections', label: 'Sections', icon: IconLayers },
          { to: '/admin/students', label: 'Students', icon: IconGraduation },
          { to: '/admin/subjects', label: 'Subjects', icon: IconBook },
        ]}
        onMore={() => setDrawerOpen(true)}
      />
    </div>
  );
}
