import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Input.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { authApi } from '../api/auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Step 1 of password recovery: request an OTP. The response is deliberately
 * generic — the UI cannot reveal whether an account exists.
 * Step 2 (code + new password) lives at /reset-password.
 */
export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState(null);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) { setFieldError('Enter a valid email address'); return; }
    setFieldError(null); setError(null); setLoading(true);
    try {
      await authApi.requestResetOtp(email.trim());
      setSent(true);
    } catch (err) {
      setError(err?.message || 'Unable to send the code right now. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle="If your account is eligible, a 6-digit code is on its way."
        footer={
          <p>
            Remembered it?{' '}
            <Link to="/login" className="rounded font-medium text-primary-600 hover:text-primary-700 hover:underline">
              Back to sign in
            </Link>
          </p>
        }
      >
        <div className="space-y-5 text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-full bg-primary-50" aria-hidden="true">
            <svg className="size-7 text-primary-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
            </svg>
          </div>
          <p className="text-sm text-slate-500">
            Enter the code on the next screen within 10 minutes to set a new password for{' '}
            <span className="font-medium text-slate-700">{email}</span>.
          </p>
          <Button onClick={() => navigate(`/reset-password?email=${encodeURIComponent(email.trim())}`)} className="w-full" size="lg">
            I have the code — continue
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Forgot your password?"
      subtitle="We'll email you a verification code to set a new one."
      footer={
        <p>
          <Link to="/login" className="rounded font-medium text-primary-600 hover:text-primary-700 hover:underline">
            Back to sign in
          </Link>
        </p>
      }
    >
      {error && <Alert variant="danger" className="mb-4">{error}</Alert>}
      <form onSubmit={submit} noValidate className="space-y-4">
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@iub.edu.pk"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldError}
          required
        />
        <Button type="submit" loading={loading} className="w-full" size="lg">
          Send verification code
        </Button>
      </form>
    </AuthLayout>
  );
}
