import { useState } from 'react';
import { Card } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input } from '../ui/Input.jsx';
import { authApi } from '../../api/auth.js';

/**
 * STEP 18 — self-service password rotation card (CR & Student profiles).
 * Requires the CURRENT password (re-authentication), enforces the same
 * policy as activation, and never displays or echoes either value.
 * The session cookie stays valid — no re-login needed.
 */
export function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const submit = async (e) => {
    e.preventDefault();
    setOk(null);
    setError(null);
    const errs = {};
    if (!currentPassword) errs.currentPassword = 'Enter your current password.';
    if (newPassword.length < 8) errs.newPassword = 'At least 8 characters.';
    else if (!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
      errs.newPassword = 'Mix upper & lower case, a number and a symbol.';
    }
    if (newPassword !== confirmPassword) errs.confirmPassword = 'Passwords do not match.';
    if (newPassword && newPassword === currentPassword) errs.newPassword = 'Choose a different password from your current one.';
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;

    setBusy(true);
    try {
      await authApi.changePassword(currentPassword, newPassword);
      setOk('Password changed — it applies from your next sign-in.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      // 401 → wrong current password; validation → policy message
      setError(err?.status === 401 ? 'Your current password is incorrect.' : err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-6 sm:p-8">
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Change password</h3>
          <p className="mt-0.5 text-sm text-slate-500">
            Use at least 8 characters with upper &amp; lower case, a number and a symbol.
          </p>
        </div>
        <Input
          label="Current password" id="cp-current" type="password" autoComplete="current-password"
          value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
          error={fieldErrors.currentPassword ?? null} required
        />
        <Input
          label="New password" id="cp-new" type="password" autoComplete="new-password"
          value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
          error={fieldErrors.newPassword ?? null} required
        />
        <Input
          label="Confirm new password" id="cp-confirm" type="password" autoComplete="new-password"
          value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
          error={fieldErrors.confirmPassword ?? null} required
        />
        {error && (
          <p role="alert" className="text-sm font-medium text-red-600">
            {typeof error === 'string' ? error : error?.message ?? 'Password change failed. Please try again.'}
          </p>
        )}
        {ok && <p role="status" className="text-sm font-medium text-emerald-600">{ok}</p>}
        <div>
          <Button type="submit" loading={busy}>Change password</Button>
        </div>
      </form>
    </Card>
  );
}
