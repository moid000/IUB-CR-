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
import RoleHome from './pages/roles/RoleHome.jsx';
import NotFound from './pages/NotFound.jsx';
import Forbidden from './pages/Forbidden.jsx';

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

            {/* Protected, role-aware (UX only — backend enforces authorization) */}
            <Route path="/admin" element={<RequireRole roles={['ADMIN']}><RoleHome area="admin" label="Admin" /></RequireRole>} />
            <Route path="/admin/*" element={<Navigate to="/admin" replace />} />
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
