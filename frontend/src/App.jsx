import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.jsx';
import { RequireRole, RedirectIfAuthenticated } from './auth/RequireRole.jsx';
import { ErrorBoundary } from './pages/ErrorBoundary.jsx';
import RootRedirect from './pages/RootRedirect.jsx';
import Login from './pages/Login.jsx';
import CrActivate from './pages/CrActivate.jsx';
import StudentActivate from './pages/StudentActivate.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import NotFound from './pages/NotFound.jsx';
import Forbidden from './pages/Forbidden.jsx';
import AdminLayout from './admin/AdminLayout.jsx';
import AdminOverview from './pages/admin/AdminOverview.jsx';
import DepartmentsPage from './pages/admin/DepartmentsPage.jsx';
import SessionsPage from './pages/admin/SessionsPage.jsx';
import SectionsPage from './pages/admin/SectionsPage.jsx';
import CrsPage from './pages/admin/CrsPage.jsx';
import StudentsPage from './pages/admin/StudentsPage.jsx';
import SubjectsPage from './pages/admin/SubjectsPage.jsx';
import AdminNotFound from './pages/admin/AdminNotFound.jsx';
import RoleHome from './pages/roles/RoleHome.jsx';

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Public */}
            <Route path="/" element={<RootRedirect />} />
            <Route path="/login" element={<RedirectIfAuthenticated><Login /></RedirectIfAuthenticated>} />
            <Route path="/cr/activate" element={<CrActivate />} />
            <Route path="/student/activate" element={<StudentActivate />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/forbidden" element={<Forbidden />} />

            {/* Admin — nested layout with sidebar shell (UX protection only;
                the backend remains the authorization boundary) */}
            <Route path="/admin" element={<RequireRole roles={['ADMIN']}><AdminLayout /></RequireRole>}>
              <Route index element={<AdminOverview />} />
              <Route path="departments" element={<DepartmentsPage />} />
              <Route path="sessions" element={<SessionsPage />} />
              <Route path="sections" element={<SectionsPage />} />
              <Route path="crs" element={<CrsPage />} />
              <Route path="students" element={<StudentsPage />} />
              <Route path="subjects" element={<SubjectsPage />} />
              <Route path="*" element={<AdminNotFound />} />
            </Route>

            {/* CR / Student homes (dashboards arrive in later phases) */}
            <Route path="/cr" element={<RequireRole roles={['CR']}><RoleHome area="CR" label="CR" /></RequireRole>} />
            <Route path="/cr/*" element={<Navigate to="/cr" replace />} />
            <Route path="/student" element={<RequireRole roles={['STUDENT']}><RoleHome area="student" label="Student" /></RequireRole>} />
            <Route path="/student/*" element={<Navigate to="/student" replace />} />

            {/* Fallback */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
