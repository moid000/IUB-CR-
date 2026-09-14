import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Input.jsx';
import { PasswordInput } from '../components/ui/PasswordInput.jsx';
import { PasswordChecklist, passwordMeetsPolicy } from '../components/ui/PasswordChecklist.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { OtpInput } from '../components/ui/OtpInput.jsx';
import { authApi } from '../api/auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Step 2 of password recovery: enter the emailed code and set a new password.
 * The reset token issued by verify-otp lives in component memory only —
 * it is never persisted to storage or the URL.
 */
export default function ResetPassword() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) { setError('Enter a valid email address.'); return; }
    if (otp.length !== 6) { setError('Enter the 6-digit code from your email.'); return; }
    if (!passwordMeetsPolicy(password)) { setError('Password does not meet the requirements below.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setError(null); setLoading(true);
    try {
      const verify = await authApi.verifyResetOtp(email.trim(), otp);
      await authApi.setResetPassword(verify?.resetToken, password);
      setDone(true);
    } catch (err) {
      setError(err?.message || 'That code is invalid or has expired.');
      setOtp('');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <AuthLayout
        title="Password updated"
        subtitle="Your new password is ready to use."
        footer={
          <p>
            <Link to="/login" className="rounded font-medium text-primary-600 hover:text-primary-700 hover:underline">
              Back to sign in
            </Link>
          </p>
        }
      >
        <div className="space-y-5 text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-full bg-emerald-100" aria-hidden="true">
            <svg className="size-7 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
            </svg>
          </div>
          <p className="text-sm text-slate-500">Sign in with your new password to continue.</p>
          <Button onClick={() => navigate('/login', { replace: true })} className="w-full" size="lg">
            Go to sign in
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter the 6-digit code we emailed you, then choose a new password."
      footer={
        <p>
          Didn't get a code?{' '}
          <Link to="/forgot-password" className="rounded font-medium text-primary-600 hover:text-primary-700 hover:underline">
            Request a new one
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
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="reset-otp">
            Verification code
          </label>
          <div id="reset-otp">
            <OtpInput value={otp} onChange={setOtp} disabled={loading} invalid={Boolean(error)} />
          </div>
        </div>
        <PasswordInput
          label="New password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <PasswordChecklist password={password} />
        <PasswordInput
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={confirm && password !== confirm ? 'Passwords do not match' : null}
          required
        />
        <Button
          type="submit"
          loading={loading}
          disabled={!EMAIL_RE.test(email.trim()) || otp.length !== 6 || !passwordMeetsPolicy(password) || password !== confirm}
          className="w-full"
          size="lg"
        >
          Reset password
        </Button>
      </form>
    </AuthLayout>
  );
}
