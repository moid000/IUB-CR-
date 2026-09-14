import { useNavigate } from 'react-router-dom';
import { Brand } from '../../components/Brand.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { PageContainer } from '../../components/ui/PageContainer.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';

/**
 * Minimal placeholder home per role — the real dashboards arrive in the
 * next phases. This exists so role-based routing is fully verifiable.
 */
export default function RoleHome({ area, label }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <PageContainer className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <header className="mb-8 flex items-center justify-between gap-4">
        <Brand />
        <Button variant="secondary" size="sm" onClick={signOut}>Sign out</Button>
      </header>

      <div className="rounded-2xl border border-slate-200/70 bg-white/80 p-8 shadow-soft backdrop-blur-sm animate-fade-up sm:p-10">
        <Badge variant="primary" className="mb-3">{user?.role ?? 'Signed in'}</Badge>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Welcome back{user?.name ? `, ${user.name.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          The {label} workspace is verified and ready — the full {area} experience arrives in the next phase.
        </p>
        <div className="mt-6 grid gap-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-600 sm:grid-cols-2">
          <p><span className="font-medium text-slate-700">Signed in as</span><br />{user?.email}</p>
          <p><span className="font-medium text-slate-700">Section</span><br />{user?.section?.name ?? '—'}</p>
        </div>
      </div>
    </PageContainer>
  );
}
