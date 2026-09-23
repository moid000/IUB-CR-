import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

/** Public landing — lazy-loaded, alongside (not after) session restoration. */
const Landing = lazy(() => import('./Landing.jsx'));

/** Root route: authenticated users go to their home; visitors see the landing. */
export default function RootRedirect() {
  const { ready, isAuthenticated, home } = useAuth();
  // This route is public. Do not block its first paint on /api/auth/me:
  // a cold serverless 401 can take longer than downloading the landing itself.
  // Once the session is verified, an authenticated visitor is redirected.
  if (ready && isAuthenticated) return <Navigate to={home} replace />;
  return (
    <Suspense fallback={<div className="min-h-dvh bg-white" aria-label="Loading landing page" />}>
      <Landing />
    </Suspense>
  );
}
