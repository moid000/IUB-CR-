import { useEffect, useState } from 'react';
import { adminApi } from '../../api/admin.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { PageHeader } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Skeleton } from '../../components/ui/Skeleton.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { IconShield, IconChatBubble } from '../../components/icons.jsx';

/**
 * Administration — owner profile + data-protection overview.
 * The profile (email + WhatsApp) is what EVERY data deletion is gated
 * behind: the wipe endpoint only runs when a verification code emailed here
 * AND a code sent to this WhatsApp number are both entered. There is no
 * delete button anywhere in the admin panel anymore.
 */
export default function AdministrationPage() {
  const [expStats, setExpStats] = useState(null);
  const [expBusy, setExpBusy] = useState(false);
  const [expError, setExpError] = useState(null);
  const [expDone, setExpDone] = useState(null);
  const { items: data, loading, error } = useAdminQuery(() => adminApi.administration.getProfile(), []);
  const { items: botData, loading: botLoading, error: botQueryError } = useAdminQuery(() => adminApi.chatbot.get(), []);
  // Teacher-agent learning examples (owner night #8)
  useEffect(() => {
    let alive = true;
    adminApi.experience.get().then((res) => { if (alive) setExpStats(res.data); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const profile = data?.configured ? data.profile : null;

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [saved, setSaved] = useState(false);

  // Tri3M WhatsApp chatbot master switch state
  const [bot, setBot] = useState({ enabled: false, apiKeyConfigured: false, apiKeySource: 'none' });
  const [openaiKeyInput, setOpenaiKeyInput] = useState('');
  const [botBusy, setBotBusy] = useState(false);
  const [botError, setBotError] = useState(null);

  const refreshExperience = async () => {
    setExpBusy(true); setExpError(null); setExpDone(null);
    try {
      const res = await adminApi.experience.refresh();
      setExpDone(`Scanned ${res.data.pairsScanned} exchanges — added ${res.data.chatAdded} reply and ${res.data.classifyAdded} verdict examples.`);
      const stats = await adminApi.experience.get();
      setExpStats(stats.data);
    } catch (err) {
      setExpError(err?.message ?? 'Could not refresh the learning examples.');
    } finally {
      setExpBusy(false);
    }
  };
  const [botSaved, setBotSaved] = useState(false);

  useEffect(() => {
    if (botData) {
      setBot({
        enabled: botData.enabled === true,
        apiKeyConfigured: botData.apiKeyConfigured === true,
        apiKeySource: botData.apiKeySource ?? 'none',
        openaiKeyConfigured: botData.openaiKeyConfigured === true,
        openaiKeySource: botData.openaiKeySource ?? 'none',
      });
    }
  }, [botData]);

  const toggleBot = async () => {
    setBotBusy(true); setBotError(null); setBotSaved(false);
    try {
      const res = await adminApi.chatbot.update({ enabled: !bot.enabled });
      setBot({
        enabled: res.enabled === true,
        apiKeyConfigured: res.apiKeyConfigured === true,
        apiKeySource: res.apiKeySource ?? 'none',
        openaiKeyConfigured: res.openaiKeyConfigured === true,
        openaiKeySource: res.openaiKeySource ?? 'none',
      });
      setBotSaved(true);
    } catch (err) {
      setBotError(err);
    } finally {
      setBotBusy(false);
    }
  };

  // Save the OpenAI (voice-note transcription) key — panel value wins over env
  const saveOpenaiKey = async (e) => {
    e.preventDefault();
    if (!openaiKeyInput.trim()) return;
    setBotBusy(true); setBotError(null); setBotSaved(false);
    try {
      const res = await adminApi.chatbot.update({ openaiApiKey: openaiKeyInput.trim() });
      setBot((b) => ({ ...b, openaiKeyConfigured: res.openaiKeyConfigured === true,
        openaiKeySource: res.openaiKeySource ?? 'none' }));
      setOpenaiKeyInput('');
      setBotSaved(true);
    } catch (err) {
      setBotError(err);
    } finally {
      setBotBusy(false);
    }
  };

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

          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft sm:p-6" aria-label="WhatsApp chatbot switch">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-600">
                <IconChatBubble className="size-4.5" />
              </span>
              <div className="flex-1">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">WhatsApp Chatbot (Tri3M group replies)</h2>
                    <p className="mt-1 max-w-2xl text-xs text-slate-500">
                      When ON, Tri3M answers students' class questions (timetable, notes, assignments) inside
                      linked class WhatsApp groups. When OFF, the bot stays completely silent — teacher
                      confirmations and deadline alerts are never affected.
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                      bot.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    <span className={`size-2 rounded-full ${bot.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                    {bot.enabled ? 'ON' : 'OFF'}
                  </span>
                </div>

                {(botQueryError || botError) && <Alert variant="danger" className="mt-4">{(botError || botQueryError)?.message ?? 'Could not update the chatbot switch.'}</Alert>}
                {botSaved && <Alert variant="success" className="mt-4">Chatbot setting saved.</Alert>}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    variant={bot.enabled ? 'danger' : 'primary'}
                    onClick={toggleBot}
                    disabled={botBusy || botLoading}
                  >
                    {botBusy ? 'Saving…' : bot.enabled ? 'Turn bot OFF' : 'Turn bot ON'}
                  </Button>
                  <p className="text-xs text-slate-400">
                    Gemini key:{' '}
                    {bot.apiKeyConfigured
                      ? 'configured on the server'
                      : 'not set — the bot will use built-in answers only'}
                  </p>
                  <p className="w-full text-xs text-slate-400">
                    OpenAI (voice) key:{' '}
                    {bot.openaiKeyConfigured
                      ? bot.openaiKeySource === 'panel'
                        ? 'saved — voice notes are live'
                        : 'configured on the server'
                      : 'not set — voice notes stay silent'}
                  </p>
                </div>

                <form onSubmit={saveOpenaiKey} className="mt-4 flex flex-wrap items-end gap-3">
                  <div className="w-full sm:w-80">
                    <Input
                      label="OpenAI API key (voice notes)" id="openai-voice-key" type="password"
                      placeholder={bot.openaiKeyConfigured ? '•••••••• (saved — leave blank to keep)' : 'sk-…'}
                      value={openaiKeyInput} onChange={(e) => setOpenaiKeyInput(e.target.value)}
                      autoComplete="off"
                    />
                    <p className="mt-1 text-xs text-slate-400">Whisper voice-note transcription — teacher replies and group voice notes both need it.</p>
                  </div>
                  <Button type="submit" variant="secondary" disabled={botBusy || !openaiKeyInput.trim()}>
                    Save voice key
                  </Button>
                </form>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft sm:p-6" aria-label="Teacher agent learning">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-600">
                <IconChatBubble className="size-4.5" />
              </span>
              <div className="flex-1">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">Teacher-agent learning (experience library)</h2>
                    <p className="mt-1 max-w-2xl text-xs text-slate-500">
                      The teacher WhatsApp agent answers better with every conversation. Refresh mines the last
                      30 days of real teacher chats into learning examples — verbatim teacher messages paired
                      with the agent's actual good replies — and injects them into the agent's prompts.
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
                    {expStats ? `${(expStats.classify?.real ?? 0) + (expStats.chat?.real ?? 0)} live examples` : '—'}
                  </span>
                </div>

                {expError && <Alert variant="danger" className="mt-4">{expError}</Alert>}
                {expDone && <Alert variant="success" className="mt-4">{expDone}</Alert>}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button onClick={refreshExperience} disabled={expBusy}>
                    {expBusy ? 'Refreshing…' : 'Refresh learning examples'}
                  </Button>
                  <p className="text-xs text-slate-400">
                    Verdict examples: {expStats ? `${expStats.classify?.real ?? 0} real + ${expStats.classify?.seed ?? 0} seed` : '—'}
                    {' · '}Reply-style examples: {expStats ? `${expStats.chat?.real ?? 0} real + ${expStats.chat?.seed ?? 0} seed` : '—'}
                    {expStats?.lastRefreshAt ? ` · last refresh ${new Date(expStats.lastRefreshAt).toLocaleDateString()}` : ''}
                  </p>
                </div>
              </div>
            </div>
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
