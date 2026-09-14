import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { FullPageLoader } from '../auth/RequireRole.jsx';

/** Root route: role-aware redirect (or login when unauthenticated). */
export default function RootRedirect() {
  const { ready, isAuthenticated, home } = useAuth();
  if (!ready) return <FullPageLoader label="Loading IUB Class Management…" />;
  if (isAuthenticated) return <Navigate to={home} replace />;
  return <Navigate to="/login" replace />;
}
