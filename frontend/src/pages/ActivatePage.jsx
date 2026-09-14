import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Input.jsx';
import { PasswordInput } from '../components/ui/PasswordInput.jsx';
import { PasswordChecklist, passwordMeetsPolicy } from '../components/ui/PasswordChecklist.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { OtpInput } from '../components/ui/OtpInput.jsx';
import { authApi } from '../api/auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STEPS = ['Email', 'Verify code', 'Set password'];

/**
 * Shared multi-step activation flow for CR and STUDENT.
 * Academic identity (name, roll number, section, role) is fully server-
 * controlled — the UI never offers those fields.
 */
export default function ActivatePage({ role }) {
  const isCr = role === 'cr';
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [activationToken, setActivationToken] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const [fieldError, setFieldError] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // client-side mirror of the backend's 60s resend cooldown
  const startCooldown = () => {
    setCooldown(60);
    const t = setInterval(() => setCooldown((c) => {
      if (c <= 1) { clearInterval(t); return 0; }
      return c - 1;
    }), 1000);
  };

  const requestOtp = async () => {
    if (!EMAIL_RE.test(email.trim())) { setFieldError('Enter a valid email address'); return; }
    setFieldError(null); setError(null); setLoading(true);
    try {
      const res = await authApi.requestActivationOtp(role, email.trim());
      // Generic response — the UI cannot tell whether the account exists
      setNotice(res?.message || 'If the account is eligible, an OTP has been sent to your email.');
      setStep(1);
      setOtp('');
      startCooldown();
    } catch (err) {
      setError(err?.message || 'Unable to send the code right now. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const verifyOtp = async () => {
    if (otp.length !== 6) { setError('Enter the 6-digit code from your email'); return; }
    setError(null); setLoading(true);
    try {
      const res = await authApi.verifyActivationOtp(role, email.trim(), otp);
      setActivationToken(res?.activationToken ?? null);
      setNotice(null);
      setStep(2);
    } catch (err) {
      setError(err?.message || 'That code is invalid or has expired.');
      setOtp('');
    } finally {
      setLoading(false);
    }
  };

  const resendOtp = async () => {
    if (cooldown > 0 || loading) return;
    setError(null); setLoading(true);
    try {
      const res = await authApi.requestActivationOtp(role, email.trim());
      setNotice(res?.message || 'A new code has been sent if your account is eligible.');
      setOtp('');
      startCooldown();
    } catch (err) {
      setError(err?.message || 'Unable to resend right now. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const setPasswordSubmit = async (e) => {
    e.preventDefault();
    if (!passwordMeetsPolicy(password)) { setError('Password does not meet the requirements below.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setError(null); setLoading(true);
    try {
      await authApi.setActivationPassword(role, activationToken, password);
      setStep(3); // success state
    } catch (err) {
      setError(err?.message || 'Unable to set your password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title={isCr ? 'Activate your CR account' : 'Activate your student account'}
      subtitle={
        step === 3
          ? undefined
          : isCr
            ? 'Use the email your admin pre-created for you.'
            : 'Use the email your CR pre-created for you.'
      }
      maxWidth="max-w-md"
      footer={
        step === 3 ? (
          <p>Think of a strong password you can remember — you'll use it every sign in.</p>
        ) : (
          <p>
            Already activated?{' '}
            <Link to="/login" className="rounded font-medium text-primary-600 hover:text-primary-700 hover:underline">
              Sign in
            </Link>
          </p>
        )
      }
    >
      {step < 3 && (
        <ol className="mb-6 flex items-center gap-2" aria-label="Activation progress">
          {STEPS.map((s, i) => (
            <li key={s} className="flex flex-1 items-center gap-2">
              <span
                aria-current={i === step ? 'step' : undefined}
                className={`grid size-6 place-items-center rounded-full text-xs font-semibold transition-colors ${
                  i < step ? 'bg-emerald-100 text-emerald-700' : i === step ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-400'
                }`}
              >
                {i < step ? '✓' : i + 1}
              </span>
              <span className={`hidden text-xs font-medium sm:block ${i === step ? 'text-slate-900' : 'text-slate-400'}`}>{s}</span>
              {i < STEPS.length - 1 && <span className="h-px flex-1 bg-slate-200" />}
            </li>
          ))}
        </ol>
      )}

      {step === 0 && (
        <div className="space-y-4">
          {error && <Alert variant="danger">{error}</Alert>}
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            placeholder={isCr ? 'cr@iub.edu.pk' : 'you@iub.edu.pk'}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') requestOtp(); }}
            error={fieldError}
            required
          />
          <Button onClick={requestOtp} loading={loading} className="w-full" size="lg">
            Send verification code
          </Button>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          {error && <Alert variant="danger">{error}</Alert>}
          {notice && <Alert variant="success">{notice}</Alert>}
          <p className="text-sm text-slate-500">
            We sent a 6-digit code to <span className="font-medium text-slate-700">{email}</span>. It expires in 10 minutes.
          </p>
          <OtpInput value={otp} onChange={setOtp} disabled={loading} invalid={Boolean(error)} />
          <div className="flex flex-col gap-2.5">
            <Button onClick={verifyOtp} loading={loading} disabled={otp.length !== 6} className="w-full" size="lg">
              Verify code
            </Button>
            <Button onClick={resendOtp} disabled={cooldown > 0 || loading} variant="secondary" className="w-full">
              {cooldown > 0 ? `Resend available in ${cooldown}s` : 'Resend code'}
            </Button>
            <button
              type="button"
              onClick={() => { setStep(0); setError(null); setNotice(null); }}
              className="rounded text-xs font-medium text-slate-500 hover:text-slate-700 hover:underline"
            >
              Use a different email
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <form onSubmit={setPasswordSubmit} noValidate className="space-y-4">
          {error && <Alert variant="danger">{error}</Alert>}
          <PasswordInput
            label="New password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <PasswordChecklist password={password} />
          <PasswordInput
            label="Confirm password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={confirm && password !== confirm ? 'Passwords do not match' : null}
            required
          />
          <Button type="submit" loading={loading} disabled={!passwordMeetsPolicy(password) || password !== confirm} className="w-full" size="lg">
            Set password & activate
          </Button>
        </form>
      )}

      {step === 3 && (
        <div className="space-y-5 text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-full bg-emerald-100" aria-hidden="true">
            <svg className="size-7 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Account activated</h2>
            <p className="mt-1 text-sm text-slate-500">Your password is set and your account is ready.</p>
          </div>
          <Button onClick={() => navigate('/login', { replace: true })} className="w-full" size="lg">
            Continue to sign in
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}
