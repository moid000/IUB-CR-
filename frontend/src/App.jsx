import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { MotionConfig } from 'motion/react';

// The SPA is namespaced under /frontend/ (vite base), but root-level URLs
// (e.g. /admin, served by the same SPA via rewrites) are also supported.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
const ROUTER_BASENAME =
  window.location.pathname === BASE || window.location.pathname.startsWith(`${BASE}/`) ? BASE : '';
import { AuthProvider } from './auth/AuthContext.jsx';
import { RequireRole, RedirectIfAuthenticated } from './auth/RequireRole.jsx';
import { ErrorBoundary } from './pages/ErrorBoundary.jsx';
import RootRedirect from './pages/RootRedirect.jsx';
import Login from './pages/Login.jsx';
import CrActivate from './pages/CrActivate.jsx';
import GrActivate from './pages/GrActivate.jsx';
import StudentActivate from './pages/StudentActivate.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import NotFound from './pages/NotFound.jsx';
import Terms from './pages/Terms.jsx';
import Privacy from './pages/Privacy.jsx';
import Forbidden from './pages/Forbidden.jsx';
import AdminLayout from './admin/AdminLayout.jsx';
import AdminOverview from './pages/admin/AdminOverview.jsx';
import DepartmentsPage from './pages/admin/DepartmentsPage.jsx';
import SessionsPage from './pages/admin/SessionsPage.jsx';
import SectionsPage from './pages/admin/SectionsPage.jsx';
import CrsPage from './pages/admin/CrsPage.jsx';
import AdminStudentsPage from './pages/admin/StudentsPage.jsx';
import AdminSubjectsPage from './pages/admin/SubjectsPage.jsx';
import AdminNotFound from './pages/admin/AdminNotFound.jsx';
import CrLayout from './cr/CrLayout.jsx';
import CrOverview from './pages/cr/CrOverview.jsx';
import SectionPage from './pages/cr/SectionPage.jsx';
import CrStudentsPage from './pages/cr/StudentsPage.jsx';
import CrSubjectsPage from './pages/cr/SubjectsPage.jsx';
import AnnouncementsPage from './pages/cr/AnnouncementsPage.jsx';
import NotesPage from './pages/cr/NotesPage.jsx';
import AssignmentsPage from './pages/cr/AssignmentsPage.jsx';
import TimetablePage from './pages/cr/TimetablePage.jsx';
import AttendancePage from './pages/cr/AttendancePage.jsx';
import MarksPage from './pages/cr/MarksPage.jsx';
import NotificationsPage from './pages/cr/NotificationsPage.jsx';
import CrProfilePage from './pages/cr/CrProfilePage.jsx';
import CrNotFound from './pages/cr/CrNotFound.jsx';
import StudentLayout from './student/StudentLayout.jsx';
import StudentOverview from './pages/student/StudentOverview.jsx';
import StudentSubjectsPage from './pages/student/StudentSubjectsPage.jsx';
import StudentAnnouncementsPage from './pages/student/StudentAnnouncementsPage.jsx';
import StudentNotesPage from './pages/student/StudentNotesPage.jsx';
import StudentAssignmentsPage from './pages/student/StudentAssignmentsPage.jsx';
import StudentTimetablePage from './pages/student/StudentTimetablePage.jsx';
import StudentAttendancePage from './pages/student/StudentAttendancePage.jsx';
import StudentMarksPage from './pages/student/StudentMarksPage.jsx';
import StudentNotificationsPage from './pages/student/StudentNotificationsPage.jsx';
import StudentProfilePage from './pages/student/StudentProfilePage.jsx';
import StudentNotFound from './pages/student/StudentNotFound.jsx';

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <MotionConfig reducedMotion="user">
        <BrowserRouter basename={ROUTER_BASENAME}>
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
        </BrowserRouter>
      </MotionConfig>
      </AuthProvider>
    </ErrorBoundary>
  );
}
