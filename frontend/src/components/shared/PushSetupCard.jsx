import { useEffect, useState } from 'react';
import { Card } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { IconBell } from '../icons.jsx';
import { pushSupported, pushState, enablePush, disablePush } from '../../services/pushClient.js';

/**
 * Device-notifications setup card (Web Push / VAPID — free, no external
 * service). Shows current permission/subscription state and lets the user
 * enable or disable screen notifications on THIS device.
 */
export function PushSetupCard({ variant = 'student' }) {
  const [state, setState] = useState(null); // { supported, permission, subscribed }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!pushSupported()) { setState({ supported: false }); return; }
    pushState().then(setState).catch(() => setState({ supported: false }));
  }, []);

  if (!state) return null; // still probing — render nothing rather than a skeleton flash

  const onEnable = async () => {
    setBusy(true); setError('');
    try {
      await enablePush();
      setState(await pushState());
    } catch (err) {
      setError(err?.message || 'Could not enable notifications on this device.');
    } finally { setBusy(false); }
  };

  const onDisable = async () => {
    setBusy(true); setError('');
    try {
      await disablePush();
      setState(await pushState());
    } catch (err) {
      setError(err?.message || 'Could not disable notifications.');
    } finally { setBusy(false); }
  };

  const copy = variant === 'cr'
    ? {
      title: 'Device notifications',
      desc: 'Get a notification on this device\u2019s screen whenever you or the GR posts something new — announcements, notes, assignments and class reminders.',
    }
    : {
      title: 'Device notifications',
      desc: 'Get a notification on this device\u2019s screen as soon as the CR posts something new — announcements, notes, assignments and class reminders.',
    };

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-xl bg-primary-50 p-2.5 text-primary-600">
          <IconBell className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900">{copy.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">{copy.desc}</p>

          {!state.supported ? (
            <p className="mt-3 text-xs font-medium text-amber-600">
              This browser doesn&rsquo;t support device notifications (iOS: add the app to your Home Screen first, iOS 16.4+).
            </p>
          ) : state.subscribed ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                <span className="size-1.5 rounded-full bg-emerald-500" /> Enabled on this device
              </span>
              <Button variant="outline" onClick={onDisable} disabled={busy}>
                {busy ? 'Turning off…' : 'Turn off'}
              </Button>
            </div>
          ) : state.permission === 'denied' ? (
            <p className="mt-3 text-xs font-medium text-amber-600">
              Notifications are blocked for this site — allow them from your browser&rsquo;s site settings, then reload.
            </p>
          ) : (
            <div className="mt-3">
              <Button onClick={onEnable} disabled={busy}>
                {busy ? 'Enabling…' : 'Enable on this device'}
              </Button>
            </div>
          )}

          {error && <p className="mt-2 text-xs font-medium text-red-600">{error}</p>}
        </div>
      </div>
    </Card>
  );
}
