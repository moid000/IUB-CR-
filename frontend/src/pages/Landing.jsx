import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  FadeIn, Reveal, Stagger, StaggerItem, EASE,
} from '../components/motion/primitives.jsx';
import {
  IconGrid, IconUserSquare, IconGraduation, IconMegaphone, IconFileText,
  IconClipboard, IconCalendar, IconQr, IconCheckCircle, IconMenu, IconX,
  IconArrowRight, IconPlus,
} from '../components/icons.jsx';

/* ------------------------------------------------------------------ *
 *  Landing — the public face of IUB Class Management.
 *  Dark, confident, terminal-flavored. No stock art, no fake claims:
 *  every module shown is a real feature of the product.
 * ------------------------------------------------------------------ */

const RED = '#f23d3d';
const GREEN = '#22c55e';

/* ---------- smooth anchor scrolling (no global css side-effects) -- */
function useScrollTo() {
  return (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

/* =========================== NAVBAR ================================ */
const NAV_LINKS = [
  { id: 'features', label: 'Features' },
  { id: 'roles', label: 'Portals' },
  { id: 'faq', label: 'FAQ' },
];

function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const scrollTo = useScrollTo();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300
        ${scrolled ? 'border-b border-white/10 bg-[#0a0a0c]/85 backdrop-blur-xl' : 'bg-transparent'}`}
    >
      <nav className="mx-auto flex h-16 w-full max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8" aria-label="Main">
        <Link to="/" className="flex items-center gap-2.5" aria-label="IUB Class Management home">
          <span className="grid size-9 place-items-center rounded-lg bg-[#f23d3d] font-bold text-white shadow-[0_0_24px_rgba(242,61,61,0.35)]">
            IU
          </span>
          <span className="text-sm font-semibold tracking-widest text-white">
            IUB <span className="text-[#f23d3d]">CLASS MANAGEMENT</span>
          </span>
        </Link>

        <ul className="ml-auto hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => scrollTo(l.id)}
                className="text-sm font-medium text-[#a0a0a0] transition-colors hover:text-white"
              >
                {l.label}
              </button>
            </li>
          ))}
        </ul>

        <Link
          to="/frontend/login"
          className="ml-auto hidden items-center rounded-full bg-[#f23d3d] px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-[#e62e2e] hover:shadow-[0_0_28px_rgba(242,61,61,0.45)] md:ml-0 md:inline-flex"
        >
          Sign in
        </Link>

        <button
          type="button" aria-label="Toggle menu" aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="ml-auto grid size-10 place-items-center rounded-lg text-white transition-colors hover:bg-white/10 md:hidden"
        >
          {open ? <IconX className="size-5" /> : <IconMenu className="size-5" />}
        </button>
      </nav>

      <AnimatePresence>
        {open && (
          <motion.div
            className="border-b border-white/10 bg-[#0a0a0c]/95 px-4 pb-5 pt-2 backdrop-blur-xl md:hidden"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: EASE }}
          >
            {NAV_LINKS.map((l) => (
              <button
                key={l.id} type="button" onClick={() => { scrollTo(l.id); setOpen(false); }}
                className="block w-full py-3 text-left text-sm font-medium text-[#a0a0a0] transition-colors hover:text-white"
              >
                {l.label}
              </button>
            ))}
            <Link
              to="/frontend/login" onClick={() => setOpen(false)}
              className="mt-3 block rounded-full bg-[#f23d3d] px-5 py-2.5 text-center text-sm font-semibold text-white"
            >
              Sign in
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

/* =========================== TERMINAL ============================== */
const TERMINAL_STEPS = [
  { cmd: 'iubcr post announcement --pinned', out: 'delivered to every student', done: true },
  { cmd: 'iubcr upload notes "AI — Lecture 3"', out: '2 files attached', done: true },
  { cmd: 'iubcr open attendance --qr', out: 'session live — scanning…', live: true },
];

function Terminal() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (step >= TERMINAL_STEPS.length) return;
    const t = setTimeout(() => setStep((s) => s + 1), 900);
    return () => clearTimeout(t);
  }, [step]);

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-white/10 bg-[#0b0f1a] shadow-2xl shadow-black/60">
      {/* red glow */}
      <div className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-[#f23d3d]/20 blur-3xl" aria-hidden="true" />

      {/* title bar */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="size-3 rounded-full bg-[#ff5f57]" aria-hidden="true" />
        <span className="size-3 rounded-full bg-[#febc2e]" aria-hidden="true" />
        <span className="size-3 rounded-full bg-[#28c840]" aria-hidden="true" />
        <span className="ml-3 font-mono text-xs text-[#a0a0a0]">cr@iub:~/section-1M</span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-[#f23d3d]/40 bg-[#f23d3d]/10 px-2.5 py-0.5 text-[10px] font-bold tracking-widest text-[#f23d3d]">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f23d3d] opacity-75 motion-reduce:animate-none" />
            <span className="relative inline-flex size-1.5 rounded-full bg-[#f23d3d]" />
          </span>
          LIVE
        </span>
      </div>

      {/* body */}
      <div className="min-h-44 space-y-4 p-5 font-mono text-[13px] leading-relaxed">
        {TERMINAL_STEPS.slice(0, step).map((s, i) => (
          <motion.div
            key={s.cmd} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <p className="text-white">
              <span className="text-[#f23d3d]">$</span> {s.cmd}
            </p>
            <p className="mt-1 flex items-center gap-2 text-[#a0a0a0]">
              {s.done && <IconCheckCircle className="size-4 shrink-0" style={{ color: GREEN }} aria-label="done" />}
              {s.live && (
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f23d3d] opacity-75 motion-reduce:animate-none" />
                  <span className="relative inline-flex size-2 rounded-full bg-[#f23d3d]" />
                </span>
              )}
              {s.out}
            </p>
            {i === TERMINAL_STEPS.length - 1 && step >= TERMINAL_STEPS.length && (
              <p className="mt-3 text-white">
                <span className="text-[#f23d3d]">$</span> <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-[#f23d3d] align-middle motion-reduce:animate-none" aria-hidden="true" />
              </p>
            )}
          </motion.div>
        ))}
        {step < TERMINAL_STEPS.length && (
          <p className="text-white">
            <span className="text-[#f23d3d]">$</span> <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-[#f23d3d] align-middle motion-reduce:animate-none" aria-hidden="true" />
          </p>
        )}
      </div>
    </div>
  );
}

/* =========================== HERO ================================== */
function Hero() {
  const scrollTo = useScrollTo();
  return (
    <section className="relative overflow-hidden pb-16 pt-32 sm:pt-36 lg:pb-24 lg:pt-40">
      {/* backdrop: grid + glow */}
      <div className="vault-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="pointer-events-none absolute left-1/2 top-0 h-[480px] w-[880px] -translate-x-1/2 rounded-full bg-[#f23d3d]/12 blur-[120px]" aria-hidden="true" />

      <div className="relative mx-auto grid w-full max-w-7xl items-center gap-14 px-4 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8">
        <div>
          <FadeIn delay={0.05}>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-[#a0a0a0]">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#22c55e] opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex size-1.5 rounded-full bg-[#22c55e]" />
              </span>
              Live portal for IUB sections — CRs &amp; students
            </span>
          </FadeIn>

          <FadeIn delay={0.12}>
            <h1 className="mt-6 text-4xl font-bold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-[3.4rem]">
              Your class deserves
              <br />
              <span className="text-[#f23d3d]">better than a WhatsApp group.</span>
            </h1>
          </FadeIn>

          <FadeIn delay={0.2}>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-[#a0a0a0] sm:text-lg">
              Announcements, notes, assignments, timetable, attendance and marks — posted once by your CR,
              delivered instantly to every student in your section. One professional home for your whole class.
            </p>
          </FadeIn>

          <FadeIn delay={0.28}>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to="/frontend/login"
                className="inline-flex items-center gap-2 rounded-full bg-[#f23d3d] px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-[#e62e2e] hover:shadow-[0_0_36px_rgba(242,61,61,0.5)]"
              >
                Sign in to your portal <IconArrowRight className="size-4" />
              </Link>
              <button
                type="button" onClick={() => scrollTo('features')}
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-transparent px-6 py-3 text-sm font-semibold text-white transition-colors hover:border-white/40 hover:bg-white/5"
              >
                Explore features
              </button>
            </div>
            <p className="mt-4 text-xs text-[#6b6b6b]">
              Free for IUB sections · Accounts are issued by your admin or CR
            </p>
          </FadeIn>
        </div>

        <FadeIn delay={0.35}>
          <Terminal />
        </FadeIn>
      </div>

      {/* trust trio */}
      <div className="relative mx-auto mt-16 grid w-full max-w-7xl gap-6 border-t border-white/5 px-4 pt-10 sm:grid-cols-3 sm:px-6 lg:px-8">
        {[
          { big: 'One section, one truth', small: 'Everything your CR posts — organized, searchable, permanent.' },
          { big: 'Instant delivery', small: 'Every student is notified the moment something is posted.' },
          { big: 'Every file type', small: 'PDFs, slides, sheets & archives — up to 10 MB each, stored in the cloud.' },
        ].map((t, i) => (
          <Reveal key={t.big} delay={i * 0.08}>
            <p className="text-base font-semibold text-white">{t.big}</p>
            <p className="mt-1 text-sm text-[#a0a0a0]">{t.small}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* =========================== FEATURES ============================== */
const FEATURES = [
  { icon: IconMegaphone, title: 'Announcements', text: 'Pinned notices, instant delivery, read receipts — the end of “check the group”.' },
  { icon: IconFileText, title: 'Notes & files', text: 'Lecture notes with cloud uploads — any file type, organized by subject.' },
  { icon: IconClipboard, title: 'Assignments', text: 'Deadlines, instructions and student submissions — all in one place, on time.' },
  { icon: IconCalendar, title: 'Daily timetable', text: 'A calendar day-by-day schedule with rooms, plus live next-class countdown.' },
  { icon: IconQr, title: 'QR attendance', text: 'CR opens a session, students scan — verified presence in seconds.' },
  { icon: IconCheckCircle, title: 'Marks & assessments', text: 'Assessments, marks and results published straight to your section.' },
];

function FeatureCard({ icon: Icon, title, text }) {
  return (
    <StaggerItem>
      <div className="group h-full rounded-2xl border border-white/10 bg-[#0b111e] p-6 transition-all duration-300 hover:-translate-y-1 hover:border-[#f23d3d]/40 hover:shadow-[0_12px_40px_rgba(242,61,61,0.12)]">
        <span className="grid size-11 place-items-center rounded-xl border border-[#f23d3d]/30 bg-[#f23d3d]/10">
          <Icon className="size-5" style={{ color: RED }} />
        </span>
        <h3 className="mt-5 text-sm font-bold uppercase tracking-wider text-white">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-[#a0a0a0]">{text}</p>
      </div>
    </StaggerItem>
  );
}

function Features() {
  return (
    <section id="features" className="relative py-20 lg:py-28">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#f23d3d]">Features</p>
          <h2 className="mt-3 max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Everything a section needs, in one place.
          </h2>
          <p className="mt-4 max-w-2xl text-[#a0a0a0]">
            Built from real class workflows — not a generic noticeboard. Each module is designed for the way
            CRs actually run a section at IUB.
          </p>
        </Reveal>
        <Stagger className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => <FeatureCard key={f.title} {...f} />)}
        </Stagger>
      </div>
    </section>
  );
}

/* =========================== ROLES ================================= */
const ROLES = [
  {
    icon: IconUserSquare, name: 'ADMIN', accent: 'Admin',
    lines: ['Sets up departments, sessions & sections', 'Issues CR and student accounts', 'Keeps the whole campus organized'],
  },
  {
    icon: IconGrid, name: 'CR', accent: 'Class Representative',
    lines: ['Runs the section day-to-day', 'Posts, uploads & marks attendance', 'Publishes timetable and marks'],
  },
  {
    icon: IconGraduation, name: 'STUDENT', accent: 'Student',
    lines: ['Personal portal for your section', 'Read, submit & track everything', 'Attendance and marks — always current'],
  },
];

function Roles() {
  return (
    <section id="roles" className="relative py-20 lg:py-28">
      <div className="pointer-events-none absolute inset-x-0 top-1/3 h-64 bg-[#f23d3d]/[0.06] blur-[120px]" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#f23d3d]">Portals</p>
          <h2 className="mt-3 max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Three portals. One system.
          </h2>
          <p className="mt-4 max-w-2xl text-[#a0a0a0]">
            Strict role separation — everyone sees exactly what they need, and nothing they shouldn&apos;t.
          </p>
        </Reveal>
        <Stagger className="mt-12 grid gap-5 lg:grid-cols-3">
          {ROLES.map((r) => (
            <StaggerItem key={r.name}>
              <div className="h-full rounded-2xl border border-white/10 bg-[#0b111e] p-7 transition-all duration-300 hover:-translate-y-1 hover:border-[#f23d3d]/40">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl bg-[#f23d3d]/10 border border-[#f23d3d]/30">
                    <r.icon className="size-5" style={{ color: RED }} />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold tracking-widest text-white">{r.name}</h3>
                    <p className="text-xs text-[#6b6b6b]">{r.accent}</p>
                  </div>
                </div>
                <ul className="mt-5 space-y-2.5">
                  {r.lines.map((l) => (
                    <li key={l} className="flex items-start gap-2.5 text-sm text-[#a0a0a0]">
                      <IconPlus className="mt-0.5 size-3.5 shrink-0 text-[#f23d3d]" aria-hidden="true" />
                      {l}
                    </li>
                  ))}
                </ul>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}

/* =========================== FAQ =================================== */
const FAQS = [
  { q: 'Who can post content?', a: 'Only the CR of your section. Students get a clean, read-only view of everything the CR publishes — announcements, notes, assignments, timetable, attendance and marks.' },
  { q: 'How do I get an account?', a: 'Your admin creates the academic structure and issues accounts. CRs and students activate with a one-time code sent to their email — no one can self-register into your section.' },
  { q: 'Which files can be shared?', a: 'Virtually everything a class needs — PDF, Word, PowerPoint, Excel, images, archives and more, up to 10 MB per file, stored securely in the cloud.' },
  { q: 'How does QR attendance work?', a: 'Your CR opens an attendance session and a QR code appears. Students scan it from their portal — presence is verified instantly and recorded against the session.' },
  { q: 'Is it free?', a: 'Yes — built for IUB sections, free for your class. No ads, no upsells, no data selling.' },
];

function FaqItem({ q, a, open, onToggle }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b111e]">
      <button
        type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
      >
        <span className="text-sm font-semibold text-white sm:text-base">{q}</span>
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-full border transition-all duration-300
            ${open ? 'rotate-45 border-[#f23d3d] bg-[#f23d3d]/10 text-[#f23d3d]' : 'border-white/15 text-[#a0a0a0]'}`}
          aria-hidden="true"
        >
          <IconPlus className="size-3.5" />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: EASE }}
          >
            <p className="px-6 pb-6 text-sm leading-relaxed text-[#a0a0a0]">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="relative py-20 lg:py-28">
      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#f23d3d]">FAQ</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">Questions, answered.</h2>
        </Reveal>
        <div className="mt-10 space-y-3.5">
          {FAQS.map((f, i) => (
            <Reveal key={f.q} delay={i * 0.05}>
              <FaqItem q={f.q} a={f.a} open={open === i} onToggle={() => setOpen(open === i ? -1 : i)} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =========================== CTA =================================== */
function FinalCta() {
  return (
    <section className="relative py-20 lg:py-28">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-[#f23d3d]/25 bg-[#0b111e] px-6 py-14 text-center sm:px-12">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(242,61,61,0.16),transparent_60%)]" aria-hidden="true" />
            <h2 className="relative mx-auto max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Move your class off WhatsApp — <span className="text-[#f23d3d]">today.</span>
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-[#a0a0a0]">
              Your admin and CR already have accounts. Sign in and see your section organized.
            </p>
            <Link
              to="/frontend/login"
              className="relative mt-8 inline-flex items-center gap-2 rounded-full bg-[#f23d3d] px-7 py-3.5 text-sm font-semibold text-white transition-all hover:bg-[#e62e2e] hover:shadow-[0_0_44px_rgba(242,61,61,0.55)]"
            >
              Sign in to your portal <IconArrowRight className="size-4" />
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* =========================== FOOTER ================================ */
function Footer() {
  const scrollTo = useScrollTo();
  return (
    <footer className="border-t border-white/10 py-12">
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-8 px-4 sm:px-6 md:flex-row lg:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-[#f23d3d] text-sm font-bold text-white">IU</span>
          <div>
            <p className="text-sm font-semibold tracking-widest text-white">IUB CLASS MANAGEMENT</p>
            <p className="text-xs text-[#6b6b6b]">Class, handled.</p>
          </div>
        </div>
        <nav className="flex flex-wrap items-center justify-center gap-x-7 gap-y-2" aria-label="Footer">
          {NAV_LINKS.map((l) => (
            <button key={l.id} type="button" onClick={() => scrollTo(l.id)} className="text-sm text-[#a0a0a0] transition-colors hover:text-white">
              {l.label}
            </button>
          ))}
          <Link to="/frontend/login" className="text-sm text-[#a0a0a0] transition-colors hover:text-white">Sign in</Link>
        </nav>
        <p className="text-xs text-[#6b6b6b]">© 2026 IUB Class Management. All rights reserved.</p>
      </div>
    </footer>
  );
}

/* =========================== PAGE ================================== */
export default function Landing() {
  return (
    <div className="min-h-dvh bg-[#0a0a0c] text-white antialiased">
      <Navbar />
      <main>
        <Hero />
        <Features />
        <Roles />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
