import { Link } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout.jsx';
import { Button } from '../components/ui/Button.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

export default function Forbidden() {
  const { home } = useAuth();
  return (
    <AuthLayout title="Access denied" subtitle="You don't have permission to view that page." maxWidth="max-w-md">
      <div className="space-y-5 text-center">
        <p className="text-5xl font-semibold tracking-tight text-slate-200" aria-hidden="true">403</p>
        <Link to={home}>
          <Button className="w-full" size="lg">Go to my workspace</Button>
        </Link>
      </div>
    </AuthLayout>
  );
}
