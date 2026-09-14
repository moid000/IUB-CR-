import { useNavigate } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout.jsx';
import { Button } from '../components/ui/Button.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

export default function NotFound() {
  const navigate = useNavigate();
  const { ready, isAuthenticated, home } = useAuth();
  return (
    <AuthLayout title="Page not found" subtitle="The page you're looking for doesn't exist or has moved." maxWidth="max-w-md">
      <div className="space-y-5 text-center">
        <p className="text-5xl font-semibold tracking-tight text-slate-200" aria-hidden="true">404</p>
        <Button
          onClick={() => navigate(ready && isAuthenticated ? home : '/login', { replace: true })}
          className="w-full"
          size="lg"
        >
          {ready && isAuthenticated ? 'Go to my workspace' : 'Go to sign in'}
        </Button>
      </div>
    </AuthLayout>
  );
}
