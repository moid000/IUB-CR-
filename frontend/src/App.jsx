import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { MotionConfig } from 'motion/react';

// The SPA is namespaced under /frontend/ (vite base), but root-level URLs
// (e.g. /admin, served by the same SPA via rewrites) are also supported.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
const ROUTER_BASENAME =
  window.location.pathname === BASE || window.location.pathname.startsWith(`${BASE}/`) ? BASE : '';
import { AuthProvider } from './auth/AuthContext.jsx';
import { RequireRole, RedirectIfAuthenticated, FullPageLoader } from './auth/RequireRole.jsx';
import { ErrorBoundary } from './pages/ErrorBoundary.jsx';
import RootRedirect from './pages/RootRedirect.jsx';
import NotFound from './pages/NotFound.jsx';

// Route-level code splitting: a visitor only ever uses ONE portal (admin,
// CR, or student), so each portal's pages — and its layout shell — load
// as their own chunk, on demand. Nobody downloads code they'll never run.
// (Landing is already split this way via RootRedirect.)
const Login = lazy(() => import('./pages/Login.jsx'));
const CrActivate = lazy(() => import('./pages/CrActivate.jsx'));
const GrActivate = lazy(() => import('./pages/GrActivate.jsx'));
const StudentActivate = lazy(() => import('./pages/StudentActivate.jsx'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.jsx'));
const ResetPassword = lazy(() => import('./pages/ResetPassword.jsx'));
const Terms = lazy(() => import('./pages/Terms.jsx'));
const Privacy = lazy(() => import('./pages/Privacy.jsx'));
const Forbidden = lazy(() => import('./pages/Forbidden.jsx'));

const AdminLayout = lazy(() => import('./admin/AdminLayout.jsx'));
const AdminOverview = lazy(() => import('./pages/admin/AdminOverview.jsx'));
const DepartmentsPage = lazy(() => import('./pages/admin/DepartmentsPage.jsx'));
const SessionsPage = lazy(() => import('./pages/admin/SessionsPage.jsx'));
const SectionsPage = lazy(() => import('./pages/admin/SectionsPage.jsx'));
const CrsPage = lazy(() => import('./pages/admin/CrsPage.jsx'));
const AdminStudentsPage = lazy(() => import('./pages/admin/StudentsPage.jsx'));
const AdminSubjectsPage = lazy(() => import('./pages/admin/SubjectsPage.jsx'));
const AdminNotFound = lazy(() => import('./pages/admin/AdminNotFound.jsx'));

const CrLayout = lazy(() => import('./cr/CrLayout.jsx'));
const CrOverview = lazy(() => import('./pages/cr/CrOverview.jsx'));
const SectionPage = lazy(() => import('./pages/cr/SectionPage.jsx'));
const CrStudentsPage = lazy(() => import('./pages/cr/StudentsPage.jsx'));
const CrSubjectsPage = lazy(() => import('./pages/cr/SubjectsPage.jsx'));
const CrTeachersPage = lazy(() => import('./pages/cr/TeachersPage.jsx'));
const AnnouncementsPage = lazy(() => import('./pages/cr/AnnouncementsPage.jsx'));
const NotesPage = lazy(() => import('./pages/cr/NotesPage.jsx'));
const AssignmentsPage = lazy(() => import('./pages/cr/AssignmentsPage.jsx'));
const TimetablePage = lazy(() => import('./pages/cr/TimetablePage.jsx'));
const AttendancePage = lazy(() => import('./pages/cr/AttendancePage.jsx'));
const MarksPage = lazy(() => import('./pages/cr/MarksPage.jsx'));
const NotificationsPage = lazy(() => import('./pages/cr/NotificationsPage.jsx'));
const CrProfilePage = lazy(() => import('./pages/cr/CrProfilePage.jsx'));
const CrNotFound = lazy(() => import('./pages/cr/CrNotFound.jsx'));

const StudentLayout = lazy(() => import('./student/StudentLayout.jsx'));
const StudentOverview = lazy(() => import('./pages/student/StudentOverview.jsx'));
const StudentSubjectsPage = lazy(() => import('./pages/student/StudentSubjectsPage.jsx'));
const StudentAnnouncementsPage = lazy(() => import('./pages/student/StudentAnnouncementsPage.jsx'));
const StudentNotesPage = lazy(() => import('./pages/student/StudentNotesPage.jsx'));
const StudentAssignmentsPage = lazy(() => import('./pages/student/StudentAssignmentsPage.jsx'));
const StudentTimetablePage = lazy(() => import('./pages/student/StudentTimetablePage.jsx'));
const StudentAttendancePage = lazy(() => import('./pages/student/StudentAttendancePage.jsx'));
const StudentMarksPage = lazy(() => import('./pages/student/StudentMarksPage.jsx'));
const StudentNotificationsPage = lazy(() => import('./pages/student/StudentNotificationsPage.jsx'));
const StudentProfilePage = lazy(() => import('./pages/student/StudentProfilePage.jsx'));
const StudentNotFound = lazy(() => import('./pages/student/StudentNotFound.jsx'));

// Background prefetch (perceived speed, zero behavior change): once the
// user is settled in a portal, quietly download that portal's tab chunks
// so tab switches are instant. Same modules the lazy() routes use, so
// nothing is downloaded twice. Skipped for save-data / 2g users.
const PORTAL_PREFETCH = {
  student: () => Promise.all([
    import('./pages/student/StudentAnnouncementsPage.jsx'),
    import('./pages/student/StudentAssignmentsPage.jsx'),
    import('./pages/student/StudentTimetablePage.jsx'),
    import('./pages/student/StudentNotesPage.jsx'),
    import('./pages/student/StudentNotificationsPage.jsx'),
  ]),
  cr: () => Promise.all([
    import('./pages/cr/AnnouncementsPage.jsx'),
    import('./pages/cr/AssignmentsPage.jsx'),
    import('./pages/cr/TimetablePage.jsx'),
    import('./pages/cr/NotesPage.jsx'),
    import('./pages/cr/NotificationsPage.jsx'),
  ]),
  admin: () => Promise.all([
    import('./pages/admin/SectionsPage.jsx'),
    import('./pages/admin/StudentsPage.jsx'),
    import('./pages/admin/SubjectsPage.jsx'),
  ]),
};
const prefetchedPortals = new Set();

function PortalPrefetcher() {
  const { pathname } = useLocation();
  useEffect(() => {
    const portal = pathname.startsWith('/student') ? 'student'
      : pathname.startsWith('/cr') ? 'cr'
        : pathname.startsWith('/admin') ? 'admin' : null;
    if (!portal || prefetchedPortals.has(portal)) return;
    const conn = navigator.connection;
    if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))) return;
    const id = setTimeout(() => {
      if (prefetchedPortals.has(portal)) return;
      prefetchedPortals.add(portal);
      PORTAL_PREFETCH[portal]().catch(() => {});
    }, 2500);
    return () => clearTimeout(id);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <MotionConfig reducedMotion="user">
        <BrowserRouter basename={ROUTER_BASENAME}>
          <PortalPrefetcher />
          <Suspense fallback={<FullPageLoader label="Loading…" />}>
          <Routes>
            {/* Public */}
            <Route path="/" element={<RootRedirect />} />
            <Route path="/login" element={<RedirectIfAuthenticated><Login /></RedirectIfAuthenticated>} />
            <Route path="/cr/activate" element={<CrActivate />} />
            <Route path="/gr/activate" element={<GrActivate />} />
            <Route path="/student/activate" element={<StudentActivate />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/forbidden" element={<Forbidden />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy" element={<Privacy />} />

            {/* Admin — nested layout with sidebar shell (UX protection only;
                the backend remains the authorization boundary) */}
            <Route path="/admin" element={<RequireRole roles={['ADMIN']}><AdminLayout /></RequireRole>}>
              <Route index element={<AdminOverview />} />
              <Route path="departments" element={<DepartmentsPage />} />
              <Route path="sessions" element={<SessionsPage />} />
              <Route path="sections" element={<SectionsPage />} />
              <Route path="crs" element={<CrsPage />} />
              <Route path="students" element={<AdminStudentsPage />} />
              <Route path="subjects" element={<AdminSubjectsPage />} />
              <Route path="*" element={<AdminNotFound />} />
            </Route>

            {/* CR portal — mobile-first shell; section scoping is always
                server-derived (UX protection only, backend is authoritative) */}
            <Route path="/cr" element={<RequireRole roles={['CR', 'GR']}><CrLayout /></RequireRole>}>
              <Route index element={<CrOverview />} />
              <Route path="section" element={<SectionPage />} />
              <Route path="students" element={<CrStudentsPage />} />
              <Route path="subjects" element={<CrSubjectsPage />} />
              <Route path="teachers" element={<CrTeachersPage />} />
              <Route path="announcements" element={<AnnouncementsPage />} />
              <Route path="notes" element={<NotesPage />} />
              <Route path="assignments" element={<AssignmentsPage />} />
              <Route path="timetable" element={<TimetablePage />} />
              <Route path="attendance" element={<AttendancePage />} />
              <Route path="marks" element={<MarksPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="profile" element={<CrProfilePage />} />
              <Route path="*" element={<CrNotFound />} />
            </Route>

            {/* Student portal — mobile-first shell; section scoping is always
                server-derived (UX protection only, backend is authoritative) */}
            <Route path="/student" element={<RequireRole roles={['STUDENT']}><StudentLayout /></RequireRole>}>
              <Route index element={<StudentOverview />} />
              <Route path="subjects" element={<StudentSubjectsPage />} />
              <Route path="announcements" element={<StudentAnnouncementsPage />} />
              <Route path="notes" element={<StudentNotesPage />} />
              <Route path="assignments" element={<StudentAssignmentsPage />} />
              <Route path="timetable" element={<StudentTimetablePage />} />
              <Route path="attendance" element={<StudentAttendancePage />} />
              <Route path="marks" element={<StudentMarksPage />} />
              <Route path="notifications" element={<StudentNotificationsPage />} />
              <Route path="profile" element={<StudentProfilePage />} />
              <Route path="*" element={<StudentNotFound />} />
            </Route>

            {/* Fallback */}
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </MotionConfig>
      </AuthProvider>
    </ErrorBoundary>
  );
}
