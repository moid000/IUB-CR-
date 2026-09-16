import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Input.jsx';
import { PasswordInput } from '../components/ui/PasswordInput.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { ROLE_HOME } from '../auth/AuthContext.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [loading, setLoading] = useState(false);

  const validate = () => {
    const next = {};
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address';
    if (!password) next.password = 'Enter your password';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (e) => {
    e.preventDefault();
    setServerError(null);
    if (!validate()) return;
    setLoading(true);
    try {
      const user = await login(email.trim(), password); // cookie set + /auth/me fetch
      // If they were bounced off a protected route, send them back — but only
      // within their own role's area (never across role boundaries).
      const home = user ? (ROLE_HOME[user.role] ?? '/') : '/';
      const intended = location.state?.from;
      const safeIntended = user && intended && intended.startsWith(home) ? intended : null;
      navigate(safeIntended ?? home, { replace: true });
    } catch (err) {
      // Generic message only — never reveals whether an email exists
      setServerError(err?.message || 'Invalid email or password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back — sign in to your class portal."
      footer={
        <div className="flex flex-col items-center gap-2.5">
          <p>
            First time here?{' '}
            <Link to="/student/activate" className="rounded font-medium text-primary-600 hover:text-primary-700 hover:underline">
              Activate student account
            </Link>
            {' · '}
            <Link to="/cr/activate" className="rounded font-medium text-primary-600 hover:text-primary-700 hover:underline">
              CR activation
            </Link>
            {' · '}
            <Link to="/gr/activate" className="rounded font-medium text-primary-600 hover:text-primary-700 hover:underline">
              GR activation
            </Link>
          </p>
          <p>
            <Link to="/forgot-password" className="rounded font-medium text-primary-600 hover:text-primary-700 hover:underline">
              Forgot your password?
            </Link>
          </p>
        </div>
      }
    >
      {serverError && <Alert variant="danger" className="mb-4">{serverError}</Alert>}
      <form onSubmit={submit} noValidate className="space-y-4">
        <Input
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          required
        />
        <PasswordInput
          label="Password"
          name="password"
          autoComplete="current-password"
          placeholder="Your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          required
        />
        <Button type="submit" size="lg" loading={loading} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
