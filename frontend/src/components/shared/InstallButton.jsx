import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal.jsx';
import { IconDownload } from '../icons.jsx';

const PILL =
  'inline-flex items-center gap-2 rounded-full border border-primary-200 bg-primary-50/70 px-6 py-3 text-sm font-semibold text-primary-700 transition-all hover:border-primary-300 hover:bg-primary-100';

/**
 * In-app "Install app" button for the landing page.
 * - Chromium (Android/desktop): captures beforeinstallprompt and calls
 *   prompt() directly — the browser's native install dialog.
 * - iOS Safari: no install prompt API exists, so the button opens a short
 *   3-step "Add to Home Screen" guide instead.
 * - Renders nothing once the app is already installed (display-mode:
 *   standalone) or when neither path applies (e.g. in-app browsers).
 */
export function InstallButton() {
  const [deferred, setDeferred] = useState(null);
  const [isIos, setIsIos] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
      setInstalled(true);
      return undefined;
    }
    // iPhone/iPad (any browser is WebKit) — and iPadOS Safari masquerading
    // as desktop Safari (Macintosh + touch).
    const ua = window.navigator.userAgent;
    if (/iphone|ipod/i.test(ua) || (/ipad|macintosh/i.test(ua) && 'ontouchstart' in window)) {
      setIsIos(true);
    }
    const onInstalled = () => {
      setDeferred(null);
      setInstalled(true);
    };
    // Prompt may already have been captured at boot by main.jsx.
    if (window.__tri3mInstallPrompt) setDeferred(window.__tri3mInstallPrompt);
    if (window.__tri3mInstalled) { setInstalled(true); return undefined; }
    const onPrompt = (e) => { setDeferred(e); };
    const onLocal = () => { setDeferred(window.__tri3mInstallPrompt); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('tri3m:installprompt', onLocal);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('tri3m:installprompt', onLocal);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || (!deferred && !isIos)) return null;

  return (
    <>
      {deferred ? (
        <button
          type="button"
          className={PILL}
          onClick={() => {
            deferred.prompt();
            window.__tri3mInstallPrompt = null;
            setDeferred(null);
          }}
        >
          <IconDownload className="size-4" /> Install app
        </button>
      ) : (
        <button type="button" className={PILL} onClick={() => setGuideOpen(true)}>
          <IconDownload className="size-4" /> Add to Home Screen
        </button>
      )}

      <Modal open={guideOpen} onClose={() => setGuideOpen(false)} title="Install Tri3M on your iPhone">
        <div className="space-y-4 text-sm leading-relaxed text-slate-600">
          <ol className="space-y-3">
            <li className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700">1</span>
              <span>
                Open this page in <strong className="text-slate-900">Safari</strong>, then tap the{' '}
                <strong className="text-slate-900">Share</strong> button in the bottom bar.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700">2</span>
              <span>
                Scroll down and tap <strong className="text-slate-900">Add to Home Screen</strong>.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700">3</span>
              <span>
                Tap <strong className="text-slate-900">Add</strong> — the Tri3M icon will appear on your home screen like a normal app.
              </span>
            </li>
          </ol>
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            Tip: this works only in Safari. Inside WhatsApp&apos;s built-in browser the option is not available.
          </p>
        </div>
      </Modal>
    </>
  );
}

export default InstallButton;
