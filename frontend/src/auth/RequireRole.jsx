/**
 * Role-aware route protection.
 *
 * IMPORTANT: this is UX protection only. The backend remains the real
 * authorization boundary — the frontend never assumes otherwise.
 */
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth, ROLE_HOME } from './AuthContext.jsx';
import { PageContainer } from '../components/ui/PageContainer.jsx';
import { Spinner } from '../components/ui/Spinner.jsx';

export function RequireRole({ roles, children }) {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) return <FullPageLoader label="Checking your session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) {
    // Signed in, wrong role → their own home, not an error wall
    return <Navigate to={ROLE_HOME[user.role] ?? '/login'} replace />;
  }
  return children;
}

export function RedirectIfAuthenticated({ children }) {
  const { user, ready, home } = useAuth();
  if (!ready) return <FullPageLoader label="Checking your session…" />;
  if (user) return <Navigate to={home} replace />;
  return children;
}

export function FullPageLoader({ label }) {
  return (
    <PageContainer center>
      <div className="flex flex-col items-center gap-3 py-24" role="status" aria-live="polite">
        <Spinner size="lg" />
        <p className="text-sm text-slate-500">{label}</p>
      </div>
    </PageContainer>
  );
}
