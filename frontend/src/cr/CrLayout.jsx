import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { PageTransition } from '../components/motion/primitives.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { Avatar } from '../components/files/Avatar.jsx';
import { crApi } from '../api/cr.js';
import { Badge } from '../components/ui/Badge.jsx';
import {
  IconGrid, IconLayers, IconUsers, IconBook, IconMegaphone, IconFileText,
  IconClipboard, IconCalendar, IconQr, IconCheckCircle, IconBell, IconMenu,
  IconX, IconLogout, IconGraduation, IconUserSquare,
} from '../components/icons.jsx';

const NAV = [
  { to: '/cr', label: 'Dashboard', icon: IconGrid, end: true },
  { to: '/cr/section', label: 'My Section', icon: IconLayers },
  { to: '/cr/students', label: 'Students', icon: IconUsers },
  { to: '/cr/subjects', label: 'Subjects', icon: IconBook },
  { to: '/cr/announcements', label: 'Announcements', icon: IconMegaphone },
  { to: '/cr/notes', label: 'Notes', icon: IconFileText },
  { to: '/cr/assignments', label: 'Assignments', icon: IconClipboard },
  { to: '/cr/timetable', label: 'Timetable', icon: IconCalendar },
  { to: '/cr/attendance', label: 'Attendance', icon: IconQr },
  { to: '/cr/marks', label: 'Marks', icon: IconCheckCircle },
  { to: '/cr/notifications', label: 'Notifications', icon: IconBell, badge: 'unread' },
];

function pageTitle(pathname) {
  const match = NAV.find((n) => n.to !== '/cr' && pathname.startsWith(n.to));
  return match ? match.label : 'Dashboard';
}

export default function CrLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unread, setUnread] = useState(null);
  const menuRef = useRef(null);

  const section = user?.section;

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
      {/* ---- Sidebar: drawer on mobile, fixed rail on desktop ---- */}
      <div
        className={`fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity lg:hidden
          ${drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200/80 bg-white transition-transform duration-200 lg:w-60 lg:translate-x-0
          ${drawerOpen ? 'translate-x-0 shadow-lift' : '-translate-x-full'}`}
        aria-label="CR navigation"
      >
        <div className="flex h-16 shrink-0 items-center border-b border-slate-100 px-5">
          <NavLink to="/cr" className="flex items-center gap-2.5 rounded-lg py-1">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-600 text-white">
              <IconGraduation className="size-4.5" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-slate-900">IUB Class Management</span>
          </NavLink>
          <button
            type="button" onClick={() => setDrawerOpen(false)} aria-label="Close navigation menu"
            className="ml-auto rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:hidden"
          >
            <IconX className="size-4" />
          </button>
        </div>

        {section ? (
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Your section</p>
            <p className="mt-0.5 truncate text-sm font-medium text-slate-800">
              {section.department?.code ? `${section.department.code} — ` : ''}{section.name}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {section.department?.name}{section.semester != null ? ` · Semester ${section.semester}` : ''}
            </p>
          </div>
        ) : (
          <div className="border-b border-slate-100 px-4 py-3">
            <Badge variant="gray">No section assigned</Badge>
          </div>
        )}

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
          {NAV.map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink
              key={to} to={to} end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors
                 ${isActive ? 'bg-primary-50 text-primary-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={`size-4.5 shrink-0 ${isActive ? 'text-primary-600' : 'text-slate-400'}`} />
                  <span>{label}</span>
                  {badge === 'unread' && unread > 0 && (
                    <span
                      className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-primary-600 px-1.5 text-[11px] font-semibold text-white"
                      aria-label={`${unread} unread notifications`}
                    >
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-100 p-3">
          <NavLink
            to="/cr/profile"
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors
               ${isActive ? 'bg-primary-50 text-primary-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`
            }
          >
            <IconUserSquare className="size-4.5 text-slate-400" />
            <span>Profile</span>
          </NavLink>
        </div>
      </aside>

      {/* ---- Main column ---- */}
      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur-md">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <button
              type="button" onClick={() => setDrawerOpen(true)} aria-label="Open navigation menu"
              className="rounded-md p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
            >
              <IconMenu className="size-5" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold tracking-tight text-slate-900 sm:text-lg">
                {pageTitle(location.pathname)}
              </h1>
              {sectionLabel && (
                <p className="truncate text-xs text-slate-500">{sectionLabel}</p>
              )}
            </div>
            <div className="relative" ref={menuRef}>
              <button
                type="button" aria-haspopup="menu" aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
                className="flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1.5 pl-1.5 pr-3 text-sm font-medium text-slate-700 shadow-soft hover:border-slate-300"
              >
                <Avatar user={user} size={7} />
                <span className="hidden max-w-32 truncate sm:block">{user?.name ?? 'CR'}</span>
              </button>
              <AnimatePresence>
              {menuOpen && (
                <motion.div
                  role="menu" aria-label="Account menu"
                  className="absolute right-0 z-40 mt-2 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lift"
                  initial={{ opacity: 0, y: -6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.99 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="border-b border-slate-100 px-4 py-3">
                    <p className="truncate text-sm font-medium text-slate-900">{user?.name}</p>
                    <p className="truncate text-xs text-slate-500">{user?.email}</p>
                    <Badge variant="primary" className="mt-1.5">Class Representative</Badge>
                  </div>
                  <NavLink to="/cr/profile" role="menuitem" className="block px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
                    Profile
                  </NavLink>
                  <button
                    type="button" role="menuitem" onClick={handleLogout}
                    className="flex w-full items-center gap-2 border-t border-slate-100 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50"
                  >
                    <IconLogout className="size-4" /> Sign out
                  </button>
                </motion.div>
              )}
              </AnimatePresence>
            </div>
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
