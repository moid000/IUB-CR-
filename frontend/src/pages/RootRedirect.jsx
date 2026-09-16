import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { FullPageLoader } from '../auth/RequireRole.jsx';

/** Public landing — lazy-loaded: authenticated users never download it. */
const Landing = lazy(() => import('./Landing.jsx'));

/** Root route: authenticated users go to their home; visitors see the landing. */
export default function RootRedirect() {
  const { ready, isAuthenticated, home } = useAuth();
  if (!ready) return <FullPageLoader label="Loading Tri3M…" />;
  if (isAuthenticated) return <Navigate to={home} replace />;
  return (
    <Suspense fallback={<FullPageLoader label="Loading…" />}>
      <Landing />
    </Suspense>
  );
}
