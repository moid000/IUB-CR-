import { Link } from 'react-router-dom';
import { Brand } from './Brand.jsx';
import { FadeIn, Stagger, StaggerItem } from './motion/primitives.jsx';
import { motion } from 'motion/react';
import { IconMegaphone, IconClock, IconCheckCircle } from './icons.jsx';

/**
 * Shared shell for all auth pages — premium two-column on desktop.
 * Left: product story on a deep charcoal panel with a living background
 * (drifting aurora glow, entrance cascade). Right: the auth card.
 * Mobile-first single column below lg — the card stays the hero there.
 */

const STORY_POINTS = [
  { icon: IconMegaphone, text: 'Announcements, notes and files — scoped to your section' },
  { icon: IconClock, text: 'Daily timetable with a live next-class countdown' },
  { icon: IconCheckCircle, text: 'Attendance, assignments and marks in one place' },
];

function StoryPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-slate-900 lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16" aria-hidden="true">
      <div className="pointer-events-none absolute inset-0 hero-dot-grid opacity-[0.12]" />
      <div className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 animate-aurora-a rounded-full bg-primary-500/25 blur-3xl" />
      <div className="pointer-events-none absolute -top-24 -right-10 h-72 w-72 animate-aurora-b rounded-full bg-primary-400/15 blur-3xl" />

      <Stagger className="relative" gap={0.09}>
        <StaggerItem>
          <Link to="/" aria-label="Tri3M home" className="rounded-lg">
            <span className="inline-flex items-center gap-2.5">
              <img src={`${import.meta.env.BASE_URL}logo-256.png`} alt="Tri3M logo" className="size-9 rounded-xl object-contain shadow-sm" />
              <span className="flex flex-col leading-tight">
                <span className="text-[15px] font-semibold tracking-tight text-white">Tri3M</span>
                <span className="text-[11px] font-medium tracking-wide text-slate-400">Connect &bull; Organize &bull; Succeed</span>
              </span>
            </span>
          </Link>
        </StaggerItem>

        <StaggerItem>
          <span className="mt-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-slate-300 backdrop-blur-sm">
            <span className="relative inline-flex size-1.5 items-center justify-center">
              <span className="absolute inline-flex size-1.5 animate-live-pulse rounded-full bg-emerald-400" />
              <span className="inline-flex size-1.5 rounded-full bg-emerald-400" />
            </span>
            Live class portal
          </span>
        </StaggerItem>
      </Stagger>

      <Stagger className="relative max-w-md" gap={0.08} delay={0.15}>
        <StaggerItem>
          <h2 className="text-3xl font-semibold leading-tight tracking-tight text-white">
            Your class, in one calm workspace.
          </h2>
        </StaggerItem>
        <StaggerItem>
          <p className="mt-4 text-sm leading-relaxed text-slate-300">
            Everything your section needs to stay in sync — managed by your CR, verified per account, isolated per section.
          </p>
        </StaggerItem>
        <StaggerItem>
          <ul className="mt-8 space-y-4">
            {STORY_POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3.5">
                <motion.span
                  whileHover={{ scale: 1.08, y: -1 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/10 text-white backdrop-blur-sm"
                >
                  <Icon className="size-4" />
                </motion.span>
                <span className="text-sm font-medium text-slate-200">{text}</span>
              </li>
            ))}
          </ul>
        </StaggerItem>
      </Stagger>

      <FadeIn delay={0.5} className="relative">
        <p className="text-xs text-slate-500">Accounts are provisioned by your admin and class CR.</p>
      </FadeIn>
    </aside>
  );
}

export function AuthLayout({ title, subtitle, children, footer = null, maxWidth = 'max-w-md' }) {
  return (
    <div className="grid min-h-dvh bg-slate-50 lg:grid-cols-2">
      <StoryPanel />

      <main className="relative grid place-items-center overflow-hidden px-4 py-10 lg:py-14">
        {/* restrained background wash — living, not flashy */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 animate-aurora-a rounded-full bg-primary-100/60 blur-3xl" />
          <div className="absolute bottom-0 right-0 h-72 w-72 animate-aurora-b rounded-full bg-primary-50 blur-3xl" />
        </div>

        <div className="relative z-10 w-full max-w-md">
          {/* mobile brand — the story panel replaces it on desktop */}
          <FadeIn className="mb-8 flex justify-center lg:hidden">
            <Link to="/" aria-label="Tri3M home" className="rounded-lg">
              <Brand />
            </Link>
          </FadeIn>

          <FadeIn delay={0.06} className={`mx-auto w-full ${maxWidth}`}>
            <motion.div
              whileHover={{ y: -2 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="rounded-2xl border border-slate-200/70 bg-white/90 p-6 shadow-soft backdrop-blur-md sm:p-8"
            >
              <Stagger gap={0.05}>
                <StaggerItem>
                  <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
                  {subtitle && <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>}
                </StaggerItem>
                <StaggerItem className="mt-6">{children}</StaggerItem>
              </Stagger>
            </motion.div>

            {footer && (
              <FadeIn delay={0.22} className="mt-6 text-center text-sm text-slate-500">
                {footer}
              </FadeIn>
            )}
          </FadeIn>
        </div>
      </main>
    </div>
  );
}
