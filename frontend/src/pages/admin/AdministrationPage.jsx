import { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { PageHeader } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { IconShield } from '../../components/icons.jsx';

/**
 * Administration — owner profile + data-protection overview.
 * The profile (email + WhatsApp) is what EVERY data deletion is gated
 * behind: the wipe endpoint only runs when a verification code emailed here
 * AND a code sent to this WhatsApp number are both entered. There is no
 * delete button anywhere in the admin panel anymore.
 */
export default function AdministrationPage() {
  const { items: data, loading, error } = useAdminQuery(() => adminApi.administration.getProfile(), []);

  const profile = data?.configured ? data.profile : null;

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [saved, setSaved] = useState(false);

  // Hydrate the form once the profile arrives (server is the source of truth)
  useEffect(() => {
    if (data) {
      setName(profile?.name ?? '');
      setEmail(profile?.email ?? '');
      setWhatsapp(profile?.whatsapp ?? '');
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null); setSaved(false);
    try {
      const res = await adminApi.administration.updateProfile({ name, email, whatsapp });
      setName(res?.name ?? name);
      setEmail(res?.email ?? email);
      setWhatsapp(res?.whatsapp ?? whatsapp);
      setSaved(true);
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Administration"
        description="Owner profile and data-protection settings for Tri3M."
      />

      {error && <Alert variant="danger" className="mb-5">{error?.message ?? 'Could not load the administration profile.'}</Alert>}

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      ) : (
        <div className="space-y-5">
          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft sm:p-6" aria-label="Administration profile">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-600">
                <IconShield className="size-4.5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Administration profile</h2>
                <p className="mt-1 max-w-2xl text-xs text-slate-500">
                  These contact details protect the system's data. If Tri3M data ever needs to be
                  deleted, a verification code is emailed here and a second code is sent to this
                  WhatsApp number — deletion only happens after both are entered.
                </p>
              </div>
            </div>

            {saved && (
              <Alert variant="success" className="mt-4">
                Profile saved. Future deletion requests will require codes on both channels.
              </Alert>
            )}
            {formError && <Alert variant="danger" className="mt-4">{formError?.message ?? 'Could not save the profile.'}</Alert>}

            <form onSubmit={save} className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="admin-name" className="mb-1.5 block text-sm font-medium text-slate-700">Name (optional)</label>
                <Input
                  id="admin-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Administration"
                  autoComplete="off"
                  disabled={busy}
                />
              </div>
              <div>
                <label htmlFor="admin-email" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Email (required)
                </label>
                <Input
                  id="admin-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="administration@example.com"
                  autoComplete="off"
                  disabled={busy}
                />
              </div>
              <div>
                <label htmlFor="admin-whatsapp" className="mb-1.5 block text-sm font-medium text-slate-700">
                  WhatsApp number (required)
                </label>
                <Input
                  id="admin-whatsapp"
                  type="tel"
                  required
                  value={whatsapp}
                  onChange={(e) => setWhatsapp(e.target.value)}
                  placeholder="+92 301 2345678"
                  autoComplete="off"
                  disabled={busy}
                />
                <p className="mt-1 text-xs text-slate-400">International format — 92... without spaces is saved automatically.</p>
              </div>
              <div className="flex items-end">
                <Button type="submit" disabled={busy} className="w-full sm:w-auto">
                  {busy ? 'Saving…' : 'Save profile'}
                </Button>
              </div>
            </form>
          </section>

          <section className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5 sm:p-6" aria-label="Data deletion protection">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-100 text-emerald-600">
                <IconShield className="size-4.5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-emerald-800">Data deletion — permanently protected</h2>
                <ul className="mt-2 max-w-2xl list-disc space-y-1 pl-4 text-xs leading-relaxed text-emerald-700/90">
                  <li>The delete-all-data button has been removed from the admin panel. No account can delete data with a single click.</li>
                  <li>Data can only ever be deleted with TWO verification codes — one emailed to the administration email above, one sent to its WhatsApp number. Both must be entered together.</li>
                  <li>Codes expire in 15 minutes, work once, and a wrong pair burns after 5 attempts.</li>
                  <li>Not even an AI agent or an administrator command can bypass this — the codes physically arrive only on your two channels.</li>
                </ul>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
