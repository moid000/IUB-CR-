/**
 * Role-aware route protection.
 *
 * IMPORTANT: this is UX protection only. The backend remains the real
 * authorization boundary — the frontend never assumes otherwise.
 */
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth, ROLE_HOME } from './AuthContext.jsx';
import { FadeIn } from '../components/motion/primitives.jsx';
import { Brand } from '../components/Brand.jsx';

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

/**
 * Session/route loader — brand-first, structure over spinners.
 * The shell of the page appears (brand, text, content bars) so the app
 * feels continuous instead of flashing a blank screen + spinner.
 */
export function FullPageLoader({ label }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-50 px-6"
      role="status"
      aria-live="polite"
    >
      <FadeIn className="flex flex-col items-center text-center">
        <Brand />
        <div
          className="mt-9 size-6 animate-spin rounded-full border-[2.5px] border-slate-200 border-t-blue-600"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm text-slate-500">{label}</p>
      </FadeIn>
    </div>
  );
}
