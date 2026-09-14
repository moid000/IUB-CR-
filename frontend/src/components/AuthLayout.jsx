import { Link } from 'react-router-dom';
import { Brand } from './Brand.jsx';

/**
 * Shared shell for all auth pages — polished on mobile first.
 * Subtle white-first surface with a restrained blue wash.
 */
export function AuthLayout({ title, subtitle, children, footer = null, maxWidth = 'max-w-md' }) {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-slate-50 px-4 py-10">
      {/* restrained background wash — no flashy gradients */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-primary-100/60 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-72 w-72 rounded-full bg-primary-50 blur-3xl" />
      </div>

      <div className={`relative z-10 w-full ${maxWidth} animate-fade-up`}>
        <div className="mb-8 flex justify-center">
          <Link to="/" aria-label="IUB Class Management home" className="rounded-lg">
            <Brand />
          </Link>
        </div>

        <div className="rounded-2xl border border-slate-200/70 bg-white/80 p-6 shadow-soft backdrop-blur-md sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>

        {footer && <div className="mt-6 text-center text-sm text-slate-500">{footer}</div>}
      </div>
    </main>
  );
}
