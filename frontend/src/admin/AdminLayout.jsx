import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { PageTransition } from '../components/motion/primitives.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { Avatar } from '../components/files/Avatar.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import {
  IconGrid, IconBuilding, IconCalendar, IconLayers, IconUserSquare,
  IconGraduation, IconBook, IconMenu, IconX, IconLogout, IconChevronsLeft,
} from '../components/icons.jsx';

const NAV = [
  { to: '/admin', label: 'Overview', icon: IconGrid, end: true },
  { to: '/admin/departments', label: 'Departments', icon: IconBuilding },
  { to: '/admin/sessions', label: 'Academic Sessions', icon: IconCalendar },
  { to: '/admin/sections', label: 'Sections', icon: IconLayers },
  { to: '/admin/crs', label: 'CR Management', icon: IconUserSquare },
  { to: '/admin/students', label: 'Students', icon: IconGraduation },
  { to: '/admin/subjects', label: 'Subjects', icon: IconBook },
];

function pageTitle(pathname) {
  if (pathname === '/admin') return 'Overview';
  const match = NAV.find((n) => n.to !== '/admin' && pathname.startsWith(n.to));
  return match ? match.label : 'Admin';
}

const COLLAPSE_KEY = 'iubcr-admin-sidebar-collapsed';

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // Close the mobile drawer on navigation
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  // Click-outside + Escape closes the profile menu
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const toggleCollapse = () => setCollapsed((c) => {
    localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
    return !c;
  });

  const handleLogout = async () => {
    await logout(); // POST /api/auth/logout clears the httpOnly cookie
    navigate('/login');
  };

  const title = pageTitle(location.pathname);

  return (
    <div className="min-h-dvh bg-slate-50">
      {/* ---- Sidebar: fixed on desktop, drawer on mobile ---- */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-slate-200/80 bg-white transition-[width,transform] duration-200 lg:translate-x-0
          ${collapsed ? 'lg:w-[76px]' : 'lg:w-64'} w-64
          ${drawerOpen ? 'translate-x-0 shadow-lift' : '-translate-x-full'}`}
        aria-label="Admin navigation"
      >
        <div className={`flex h-16 shrink-0 items-center border-b border-slate-100 ${collapsed ? 'lg:justify-center lg:px-2' : 'px-5'}`}>
          <NavLink to="/admin" className="flex items-center gap-2.5 rounded-lg py-1">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-600 text-white">
              <IconGraduation className="size-4.5" />
            </span>
            <span className={`text-sm font-semibold tracking-tight text-slate-900 ${collapsed ? 'lg:hidden' : ''}`}>
              IUB Class Management
            </span>
          </NavLink>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation menu"
            className="ml-auto rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:hidden"
          >
            <IconX className="size-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={label}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors
                 ${isActive ? 'bg-primary-50 text-primary-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}
                 ${collapsed ? 'lg:justify-center lg:px-2.5' : ''}`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={`size-4.5 shrink-0 ${isActive ? 'text-primary-600' : 'text-slate-400'}`} />
                  <span className={collapsed ? 'lg:hidden' : ''}>{label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="hidden border-t border-slate-100 p-3 lg:block">
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 ${collapsed ? 'justify-center px-2.5' : ''}`}
          >
            <IconChevronsLeft className={`size-4.5 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
            <span className={collapsed ? 'hidden' : ''}>Collapse</span>
          </button>
        </div>
      </aside>

      {/* Mobile drawer backdrop */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/30 backdrop-blur-sm lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ---- Main column ---- */}
      <div className={`flex min-h-dvh flex-col transition-[padding] duration-200 ${collapsed ? 'lg:pl-[76px]' : 'lg:pl-64'}`}>
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200/70 bg-white/80 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
          >
            <IconMenu className="size-5" />
          </button>
          <h2 className="text-sm font-semibold text-slate-900 sm:text-base">{title}</h2>

          <div className="ml-auto flex items-center gap-3" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="flex items-center gap-2.5 rounded-full border border-slate-200 bg-white py-1.5 pl-1.5 pr-3 text-left shadow-sm hover:border-slate-300"
            >
              <Avatar user={user} size={7} />
              <span className="hidden max-w-[180px] sm:block">
                <span className="block truncate text-xs font-semibold text-slate-800">{user?.name ?? 'Administrator'}</span>
                <span className="block truncate text-[11px] text-slate-500">{user?.email}</span>
              </span>
              <Badge variant="primary" className="hidden sm:inline-flex">Admin</Badge>
            </button>

            <AnimatePresence>
              {menuOpen && (
              <motion.div
                role="menu"
                className="absolute right-4 top-14 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lift"
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.99 }}
                transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="border-b border-slate-100 px-4 py-3">
                  <p className="truncate text-sm font-semibold text-slate-800">{user?.name ?? 'Administrator'}</p>
                  <p className="truncate text-xs text-slate-500">{user?.email}</p>
                  <Badge variant="primary" className="mt-2">Administrator</Badge>
                </div>
                <div className="p-2">
                  <Button variant="ghost" size="sm" icon={IconLogout} onClick={handleLogout} className="w-full justify-start text-slate-700 hover:text-red-600">
                    Sign out
                  </Button>
                </div>
              </motion.div>
              )}
            </AnimatePresence>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto w-full max-w-6xl">
            <PageTransition key={location.pathname}>
              <Outlet />
            </PageTransition>
          </div>
        </main>
      </div>
    </div>
  );
}
