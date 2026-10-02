import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Input.jsx';
import { PasswordInput } from '../components/ui/PasswordInput.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { OtpInput } from '../components/ui/OtpInput.jsx';
import { authApi } from '../api/auth.js';
import { Badge } from '../components/ui/Badge.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STEPS = ['Email', 'Confirm details', 'Verify code', 'Set password'];

const ROLE_LABEL = { cr: 'Class Representative', gr: 'General Representative', student: 'Student' };

/* ------------------------------------------------------------------ *
 * RESUME SUPPORT (owner request, 2026-10-02): mobile browsers routinely
 * discard a backgrounded tab (the user switches to Gmail to read the
 * activation code) and reload the page from scratch on return, which
 * restarted the wizard at the email step. The wizard now mirrors its
 * position into sessionStorage (tab-scoped, survives reloads, cleared
 * on completion and when the tab closes) and rebuilds itself from that
 * snapshot on mount. The flow itself is unchanged — same steps, same
 * rules, same server logic. A half-written/inconsistent snapshot is
 * ignored, so resume can never put a user in a broken state.
 * ------------------------------------------------------------------ */
const OTP_TTL_MIN = 10;
const RESEND_COOLDOWN_S = 60;

function activationSaveKey(role) {
  return `tri3m:activate:${role}`;
}

/** Returns one consistent snapshot, or null when nothing usable is saved. */
function loadActivationSave(role) {
  try {
    const raw = sessionStorage.getItem(activationSaveKey(role));
    if (!raw) return null;
    const s = JSON.parse(raw);
    const step = Number(s.step);
    if (step === 0) return { step: 0, email: typeof s.email === 'string' ? s.email : '' };
    if (!Number.isInteger(step) || step < 1 || step > 3) return null; // success (4) is never persisted
    if (typeof s.email !== 'string' || !s.email) return null;
    if (!s.profile || typeof s.profile !== 'object') return null;
    if (step === 2 && !Number(s.otpSentAt)) return null;
    if (step === 3 && !s.activationToken) return null;
    return { step, email: s.email, profile: s.profile, otpSentAt: s.otpSentAt || null, activationToken: s.activationToken || null };
  } catch {
    return null; // private mode / storage disabled → resume simply doesn't apply
  }
}

/** Pre-created identity summary — lets the account holder confirm the admin/CR set them up correctly before they choose a password. */
function ConfirmDetailsStep({ profile, role, onContinue, onBack, busy }) {
  const firstName = profile?.name?.trim().split(/\s+/)[0] || 'there';
  const rows = [
    { label: 'Full name', value: profile?.name },
    { label: 'Email', value: profile?.email },
    { label: 'Phone', value: profile?.phone },
    { label: 'Department', value: profile?.department },
    { label: 'Session', value: profile?.session },
    { label: 'Semester', value: profile?.semester ? `Semester ${profile.semester}` : null },
    { label: 'Section', value: profile?.section },
    { label: 'Roll number', value: profile?.rollNo },
  ].filter((r) => r.value);

  return (
    <div className="space-y-4">
      <div className="text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-primary-50" aria-hidden="true">
          <svg className="size-6 text-primary-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 14a7 7 0 0 0-7 7h14a7 7 0 0 0-7-7Z" />
          </svg>
        </div>
        <h2 className="mt-3 text-lg font-semibold text-slate-900">Welcome, {firstName}! 👋</h2>
        <p className="mt-1 text-sm text-slate-500">
          Here's what {role === 'student' ? 'your CR' : 'your admin'} pre-added for you. Make sure it's you before we email you a code.
        </p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <Badge variant="primary" className="mb-3">{ROLE_LABEL[role] || role}</Badge>
        <dl className="space-y-2.5">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-3 text-sm">
              <dt className="shrink-0 text-slate-500">{r.label}</dt>
              <dd className="truncate text-right font-medium text-slate-900">{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="text-xs text-slate-400">
        Something look wrong? Ask {role === 'student' ? 'your CR' : 'your admin'} to fix it before you continue.
      </p>
      <Button onClick={onContinue} loading={busy} className="w-full" size="lg">
        Yes, this is me — send my code
      </Button>
      <button
        type="button"
        onClick={onBack}
        className="w-full rounded text-xs font-medium text-slate-500 hover:text-slate-700 hover:underline"
      >
        No — use a different email
      </button>
    </div>
  );
}

/**
 * Shared multi-step activation flow for CR and STUDENT.
 * Academic identity (name, roll number, section, role) is fully server-
 * controlled — the UI never offers those fields.
 */
export default function ActivatePage({ role }) {
  const isRep = role === 'cr' || role === 'gr'; // CR and GR share the activation flow
  const roleLabel = role.toUpperCase();
  const navigate = useNavigate();

  // Resume support: rebuild the wizard from the saved snapshot on mount.
  const [saved] = useState(() => loadActivationSave(role));
  const [step, setStep] = useState(saved?.step ?? 0);
  const [email, setEmail] = useState(saved?.email ?? '');
  const [otp, setOtp] = useState('');
  const [activationToken, setActivationToken] = useState(saved?.activationToken ?? null);
  const [profile, setProfile] = useState(saved?.profile ?? null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const [fieldError, setFieldError] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(() => {
    if (!saved || saved.step < 1) return null;
    const parts = ['Welcome back — we picked up right where you left off.'];
    if (saved.step === 2 && saved.otpSentAt && (Date.now() - saved.otpSentAt) > OTP_TTL_MIN * 60 * 1000) {
      parts.push('Your code may have expired — request a new one.');
    }
    return parts.join(' ');
  });
  const [loading, setLoading] = useState(false);
  const [otpSentAt, setOtpSentAt] = useState(saved?.otpSentAt ?? null);
  const [cooldown, setCooldown] = useState(() => {
    if (saved?.step !== 2 || !saved.otpSentAt) return 0;
    return Math.max(0, RESEND_COOLDOWN_S - Math.floor((Date.now() - saved.otpSentAt) / 1000));
  });

  // Mirror the wizard position into sessionStorage on every change, so a
  // tab discard → full reload resumes instead of restarting from zero.
  useEffect(() => {
    try {
      if (step >= 1 && step <= 3) {
        sessionStorage.setItem(activationSaveKey(role), JSON.stringify({ step, email, profile, activationToken, otpSentAt }));
      } else if (step === 0 && email) {
        sessionStorage.setItem(activationSaveKey(role), JSON.stringify({ step: 0, email }));
      } else {
        sessionStorage.removeItem(activationSaveKey(role)); // fresh start or activation finished
      }
    } catch { /* storage unavailable — flow still works, just without resume */ }
  }, [role, step, email, profile, activationToken, otpSentAt]);

  // A cooldown restored from a snapshot still needs its live countdown.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setInterval(() => setCooldown((c) => { if (c <= 1) { clearInterval(t); return 0; } return c - 1; }), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // client-side mirror of the backend's 60s resend cooldown
  const startCooldown = () => {
    setCooldown(60);
    const t = setInterval(() => setCooldown((c) => {
      if (c <= 1) { clearInterval(t); return 0; }
      return c - 1;
    }), 1000);
  };

  // Step 1 — look up the pre-created identity for this email. No email is
  // sent yet: the invitee first confirms the details the admin/CR entered.
  const lookup = async () => {
    if (!EMAIL_RE.test(email.trim())) { setFieldError('Enter a valid email address'); return; }
    setFieldError(null); setError(null); setNotice(null); setLoading(true);
    try {
      const res = await authApi.lookupActivation(role, email.trim());
      if (res?.status === 'active') {
        setNotice(res?.message || 'This account is already activated — sign in instead.');
        return;
      }
      setProfile(res?.profile ?? null);
      setStep(1); // confirm details
    } catch (err) {
      setError(err?.message || 'Unable to check this email right now. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Step 2 — details confirmed: NOW send the OTP to the inbox.
  const sendOtp = async () => {
    setError(null); setNotice(null); setLoading(true);
    try {
      await authApi.requestActivationOtp(role, email.trim());
      setNotice(`We sent a 6-digit code to ${email}. It expires in 10 minutes.`);
      setStep(2);
      setOtp('');
      setOtpSentAt(Date.now());
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
      setOtpSentAt(null);
      setStep(3); // set password
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
      setOtpSentAt(Date.now());
      startCooldown();
    } catch (err) {
      setError(err?.message || 'Unable to resend right now. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const setPasswordSubmit = async (e) => {
    e.preventDefault();
    if (!password) { setError('Please enter a password.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setError(null); setLoading(true);
    try {
      await authApi.setActivationPassword(role, activationToken, password);
      setStep(4); // success state
    } catch (err) {
      if (err?.status === 401) {
        // The 15-minute single-use verification token expired (e.g. the user
        // was away too long). Restart cleanly instead of leaving a dead end.
        try { sessionStorage.removeItem(activationSaveKey(role)); } catch { /* ignore */ }
        setStep(0); setEmail(''); setProfile(null); setActivationToken(null);
        setPassword(''); setConfirm('');
        setError('Your verification window expired. Please start again — it only takes a minute.');
        return;
      }
      setError(err?.message || 'Unable to set your password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title={isRep ? `Activate your ${roleLabel} account` : 'Activate your student account'}
      subtitle={
        step === 4
          ? undefined
          : isRep
            ? 'Use the email your admin pre-created for you.'
            : 'Use the email your CR pre-created for you.'
      }
      maxWidth="max-w-md"
      footer={
        step === 4 ? (
          <p>Choose a password you can remember — you'll use it every sign in.</p>
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
      {step < 4 && (
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
            placeholder={isRep ? 'cr@example.com' : 'you@example.com'}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }}
            error={fieldError}
            required
          />
          {notice && <Alert variant="warning">{notice}</Alert>}
          <Button onClick={lookup} loading={loading} className="w-full" size="lg">
            Continue
          </Button>
        </div>
      )}

      {step === 1 && (
        <ConfirmDetailsStep
          profile={profile}
          role={role}
          onContinue={sendOtp}
          onBack={() => { setStep(0); setError(null); setNotice(null); }}
          busy={loading}
        />
      )}

      {step === 2 && (
        <div className="space-y-4">
          {error && <Alert variant="danger">{error}</Alert>}
          {notice && <Alert variant="success">{notice}</Alert>}
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

      {step === 3 && (
        <form onSubmit={setPasswordSubmit} noValidate className="space-y-4">
          {error && <Alert variant="danger">{error}</Alert>}
          <PasswordInput
            label="New password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <PasswordInput
            label="Confirm password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={confirm && password !== confirm ? 'Passwords do not match' : null}
            required
          />
          <Button type="submit" loading={loading} disabled={!password || password !== confirm} className="w-full" size="lg">
            Set password & activate
          </Button>
        </form>
      )}

      {step === 4 && (
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
