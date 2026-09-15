import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  FadeIn, Reveal, Stagger, StaggerItem, EASE,
} from '../components/motion/primitives.jsx';
import {
  IconGrid, IconUserSquare, IconGraduation, IconMegaphone, IconFileText,
  IconClipboard, IconQr, IconCheckCircle, IconMenu, IconX,
  IconArrowRight, IconPlus, IconBell, IconClock, IconCheck, IconBuilding,
} from '../components/icons.jsx';

/* ------------------------------------------------------------------ *
 *  Landing — the public face of IUB Class Management.
 *  White, premium, product-first. No stock art, no fake claims:
 *  every module shown is a real feature of the product. Visuals carry
 *  the story (animated product mock + live feature vignettes).
 * ------------------------------------------------------------------ */

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
  { id: 'how', label: 'How it works' },
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
        ${scrolled ? 'border-b border-slate-200/70 bg-white/85 shadow-[0_1px_12px_rgb(16_24_40/0.04)] backdrop-blur-xl' : 'border-b border-transparent bg-transparent'}`}
    >
      <nav className="mx-auto flex h-16 w-full max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8" aria-label="Main">
        <Link to="/" className="flex items-center gap-2.5" aria-label="IUB Class Management home">
          <span className="grid size-9 place-items-center rounded-xl bg-primary-600 text-sm font-bold text-white shadow-[0_6px_16px_rgb(37_99_235/0.35)]">
            IU
          </span>
          <span className="text-sm font-semibold tracking-widest text-slate-900">
            IUB <span className="text-primary-600">CLASS MANAGEMENT</span>
          </span>
        </Link>

        <ul className="ml-auto hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => scrollTo(l.id)}
                className="text-sm font-medium text-slate-600 transition-colors hover:text-primary-600"
              >
                {l.label}
              </button>
            </li>
          ))}
        </ul>

        <Link
          to="/login"
          className="ml-auto hidden items-center rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white shadow-[0_6px_20px_rgb(37_99_235/0.3)] transition-all hover:bg-primary-700 hover:shadow-[0_8px_28px_rgb(37_99_235/0.42)] md:ml-0 md:inline-flex"
        >
          Sign in
        </Link>

        <button
          type="button" aria-label="Toggle menu" aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="ml-auto grid size-10 place-items-center rounded-lg text-slate-700 transition-colors hover:bg-slate-100 md:hidden"
        >
          {open ? <IconX className="size-5" /> : <IconMenu className="size-5" />}
        </button>
      </nav>

      <AnimatePresence>
        {open && (
          <motion.div
            className="border-b border-slate-200 bg-white px-4 pb-5 pt-2 shadow-lg md:hidden"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: EASE }}
          >
            {NAV_LINKS.map((l) => (
              <button
                key={l.id} type="button" onClick={() => { scrollTo(l.id); setOpen(false); }}
                className="block w-full py-3 text-left text-sm font-medium text-slate-600 transition-colors hover:text-primary-600"
              >
                {l.label}
              </button>
            ))}
            <Link
              to="/login" onClick={() => setOpen(false)}
              className="mt-3 block rounded-full bg-primary-600 px-5 py-2.5 text-center text-sm font-semibold text-white"
            >
              Sign in
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

/* ==================== HERO PRODUCT MOCK ============================ *
 *  A living miniature of the real app: an announcement slides in,
 *  delivery confirms, a QR session opens. Pure CSS/motion — no
 *  screenshots, sample content only.
 * */
const MOCK_STEPS = [
  { id: 'post', chip: 'Announcement', title: 'Quiz — Wednesday, room B-204', meta: 'pinned · by CR' },
  { id: 'notes', chip: 'Notes', title: 'AI — Lecture 3.pdf', meta: '2 files attached' },
  { id: 'qr', chip: 'Attendance', title: 'QR session live', meta: 'scanning…' },
];

function HeroMock() {
  const [step, setStep] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setStep((s) => (s % MOCK_STEPS.length) + 1), 2100);
    return () => clearTimeout(t);
  }, [step]);

  const visible = MOCK_STEPS.slice(0, step);

  return (
    <div className="relative">
      {/* floating confirmation chips */}
      <motion.div
        className="absolute -right-2 top-10 z-10 hidden items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-[0_10px_36px_rgb(16_24_40/0.12)] sm:flex"
        animate={{ y: [0, -7, 0] }} transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
      >
        <span className="grid size-6 place-items-center rounded-full bg-emerald-50 text-emerald-600">
          <IconCheck className="size-3.5" />
        </span>
        <div>
          <p className="text-xs font-semibold text-slate-900">Assignment submitted</p>
          <p className="text-[10px] text-slate-500">just now</p>
        </div>
      </motion.div>
      <motion.div
        className="absolute -left-2 bottom-14 z-10 hidden items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-[0_10px_36px_rgb(16_24_40/0.12)] sm:flex"
        animate={{ y: [0, 8, 0] }} transition={{ duration: 5.2, repeat: Infinity, ease: 'easeInOut', delay: 0.6 }}
      >
        <span className="grid size-6 place-items-center rounded-full bg-primary-50 text-primary-600">
          <IconCheckCircle className="size-3.5" />
        </span>
        <div>
          <p className="text-xs font-semibold text-slate-900">Attendance recorded</p>
          <p className="text-[10px] text-slate-500">via QR · verified</p>
        </div>
      </motion.div>

      {/* the app window */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-[0_24px_80px_-24px_rgb(16_24_40/0.25),0_4px_16px_rgb(16_24_40/0.06)]">
        {/* window bar */}
        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-3">
          <span className="size-2.5 rounded-full bg-slate-300" aria-hidden="true" />
          <span className="size-2.5 rounded-full bg-slate-300" aria-hidden="true" />
          <span className="size-2.5 rounded-full bg-slate-300" aria-hidden="true" />
          <span className="ml-3 hidden rounded-md border border-slate-200 bg-white px-2.5 py-0.5 text-[11px] font-medium text-slate-500 sm:block">
            iubcr · Section 1M · Fall 2026
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold tracking-widest text-emerald-600">
            <span className="size-1.5 rounded-full bg-emerald-500 animate-live-pulse" />
            LIVE
          </span>
        </div>

        {/* body */}
        <div className="p-4 sm:p-5">
          {/* sidebar hint */}
          <div className="mb-4 flex items-center gap-1.5">
            {['Overview', 'Announcements', 'Timetable', 'Marks'].map((t, i) => (
              <span
                key={t}
                className={`hidden rounded-lg px-2.5 py-1 text-[11px] font-medium sm:block ${i === 1 ? 'bg-primary-50 text-primary-700' : 'text-slate-400'}`}
              >
                {t}
              </span>
            ))}
          </div>

          {/* animated feed */}
          <div className="min-h-56 space-y-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3.5 sm:p-4">
            <AnimatePresence mode="popLayout">
              {visible.map((s) => (
                <motion.div
                  key={s.id}
                  layout
                  initial={{ opacity: 0, y: 14, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.4, ease: EASE }}
                  className="flex items-center gap-3 rounded-xl border border-slate-200/80 bg-white p-3.5 shadow-[0_1px_3px_rgb(16_24_40/0.05)]"
                >
                  {s.id === 'qr' ? (
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-600">
                      <IconQr className="size-5" />
                    </span>
                  ) : s.id === 'notes' ? (
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-violet-50 text-violet-600">
                      <IconFileText className="size-5" />
                    </span>
                  ) : (
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-600">
                      <IconMegaphone className="size-5" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[13px] font-semibold text-slate-900">{s.title}</p>
                      {s.id === 'post' && (
                        <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-600">pinned</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">{s.meta}</p>
                  </div>
                  {s.id === 'qr' ? (
                    <span className="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-900">
                      <span className="absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded bg-primary-400/90 animate-scan-beam" />
                    </span>
                  ) : (
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-500">
                      <IconCheck className="size-4" />
                    </span>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>

            {/* delivery hint */}
            <div className="flex items-center gap-2.5 px-1 pt-1">
              <IconBell className="size-3.5 text-primary-500 animate-icon-wiggle" aria-hidden="true" />
              <p className="text-[11px] font-medium text-slate-500">
                Delivered instantly to every student in the section
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================== HERO ================================== */
function Hero() {
  const scrollTo = useScrollTo();
  return (
    <section className="relative overflow-hidden pb-16 pt-28 sm:pt-32 lg:pb-24 lg:pt-36">
      {/* backdrop: dot grid + drifting aurora glow */}
      <div className="hero-dot-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="pointer-events-none absolute -left-24 top-8 size-[420px] rounded-full bg-primary-200/45 blur-[110px] animate-aurora-a" aria-hidden="true" />
      <div className="pointer-events-none absolute -right-24 top-40 size-[380px] rounded-full bg-sky-200/40 blur-[110px] animate-aurora-b" aria-hidden="true" />

      <div className="relative mx-auto grid w-full max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-[1fr_1.05fr] lg:gap-16 lg:px-8">
        <div>
          <FadeIn delay={0.05}>
            <span className="inline-flex items-center gap-2 rounded-full border border-primary-100 bg-primary-50/80 px-3.5 py-1.5 text-xs font-medium text-primary-700">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
              </span>
              Live portal for IUB sections — CRs &amp; students
            </span>
          </FadeIn>

          <FadeIn delay={0.12}>
            <h1 className="mt-6 text-4xl font-bold leading-[1.06] tracking-tight text-slate-900 sm:text-5xl lg:text-[3.4rem]">
              Your class deserves
              <br />
              <span className="bg-gradient-to-r from-primary-600 via-blue-500 to-sky-500 bg-clip-text text-transparent">better than a WhatsApp group.</span>
            </h1>
          </FadeIn>

          <FadeIn delay={0.2}>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg">
              Announcements, notes, assignments, timetable, attendance and marks — posted once by your CR,
              delivered instantly to every student in your section. One professional home for your whole class.
            </p>
          </FadeIn>

          <FadeIn delay={0.28}>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to="/login"
                className="inline-flex items-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white shadow-[0_10px_30px_-6px_rgb(37_99_235/0.5)] transition-all hover:bg-primary-700 hover:shadow-[0_14px_38px_-6px_rgb(37_99_235/0.55)]"
              >
                Sign in to your portal <IconArrowRight className="size-4" />
              </Link>
              <button
                type="button" onClick={() => scrollTo('features')}
                className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white/70 px-6 py-3 text-sm font-semibold text-slate-700 backdrop-blur transition-all hover:border-primary-300 hover:bg-primary-50/60 hover:text-primary-700"
              >
                Explore features
              </button>
            </div>
            <p className="mt-4 text-xs text-slate-500">
              Free for IUB sections · Accounts are issued by your admin or CR
            </p>
          </FadeIn>
        </div>

        <FadeIn delay={0.35} className="lg:pl-4">
          <HeroMock />
        </FadeIn>
      </div>

      {/* animated stat counters */}
      <StatsBand />
    </section>
  );
}

/* ==================== FEATURE VIGNETTES ============================ *
 *  Each card carries a small living visual — the feature explains
 *  itself before you read a word. All loops are GPU-friendly CSS.
 * */
function VAnnouncements() {
  return (
    <div className="relative flex h-full items-center justify-center gap-2">
      {['A+', 'B-', 'C+'].map((m, i) => (
        <span key={m} className="grid size-9 place-items-center rounded-lg bg-primary-50 text-xs font-bold text-primary-700" style={{ opacity: 0.55 + i * 0.22 }}>{m}</span>
      ))}
      <span className="grid size-12 place-items-center rounded-xl bg-primary-600 text-white shadow-[0_8px_20px_rgb(37_99_235/0.35)]">
        <IconBell className="size-5 animate-icon-wiggle" />
      </span>
      <span className="absolute right-4 top-3 grid size-6 place-items-center rounded-full bg-emerald-500 text-white shadow-md">
        <IconCheck className="size-3.5" />
      </span>
    </div>
  );
}
function VNotes() {
  return (
    <div className="relative flex h-full items-center justify-center">
      <span className="grid size-14 place-items-center rounded-2xl border border-slate-200 bg-white shadow-[0_8px_24px_rgb(16_24_40/0.1)]">
        <IconFileText className="size-6 text-slate-400" />
      </span>
      <span className="absolute right-[30%] top-4 grid size-9 place-items-center rounded-xl bg-primary-600 text-white shadow-[0_6px_16px_rgb(37_99_235/0.4)]">
        <IconArrowRight className="size-4 -rotate-90 animate-icon-upload" />
      </span>
    </div>
  );
}
function VAssignments() {
  return (
    <div className="relative flex h-full items-center justify-center">
      <span className="grid size-14 place-items-center rounded-2xl border border-slate-200 bg-white shadow-[0_8px_24px_rgb(16_24_40/0.1)]">
        <IconClipboard className="size-6 text-slate-400" />
      </span>
      <svg className="absolute left-1/2 top-1/2 -translate-x-[38%] -translate-y-[88%]" width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 13l4 4 10-11" stroke="#059669" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="animate-dash-draw" />
      </svg>
    </div>
  );
}
function VTimetable() {
  return (
    <div className="relative flex h-full items-center justify-center gap-3">
      <span className="relative grid size-14 place-items-center rounded-2xl border border-slate-200 bg-white shadow-[0_8px_24px_rgb(16_24_40/0.1)]">
        <IconClock className="size-7 text-slate-300" />
        <span className="absolute left-1/2 top-1/2 -translate-x-[3px] -translate-y-[13px]">
          <span className="block h-4 w-0.5 origin-bottom rounded bg-primary-500 animate-clock-tick" />
        </span>
      </span>
      <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-semibold text-amber-700">
        <span className="size-1.5 rounded-full bg-amber-500 animate-live-pulse" /> Next class · 25m
      </span>
    </div>
  );
}
function VAttendance() {
  return (
    <div className="relative flex h-full items-center justify-center">
      <span className="relative grid size-20 place-items-center overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_8px_24px_rgb(16_24_40/0.1)]">
        <span className="absolute left-2 top-2 size-3.5 rounded-tl-md border-l-[3px] border-t-[3px] border-primary-500" />
        <span className="absolute right-2 top-2 size-3.5 rounded-tr-md border-r-[3px] border-t-[3px] border-primary-500" />
        <span className="absolute bottom-2 left-2 size-3.5 rounded-bl-md border-b-[3px] border-l-[3px] border-primary-500" />
        <span className="absolute bottom-2 right-2 size-3.5 rounded-br-md border-b-[3px] border-r-[3px] border-primary-500" />
        <span className="absolute inset-x-3 top-1/2 h-1 -translate-y-1/2 rounded bg-gradient-to-r from-transparent via-primary-400 to-transparent animate-scan-beam" />
      </span>
      <span className="absolute right-[24%] top-5 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-600">
        <IconCheck className="size-3" /> present
      </span>
    </div>
  );
}
function VMarks() {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-2">
      <div className="flex h-16 items-end gap-2.5">
        <span className="w-4 rounded-t-md bg-primary-200 animate-bar-1" style={{ height: '35%' }} />
        <span className="w-4 rounded-t-md bg-primary-400 animate-bar-2" style={{ height: '65%' }} />
        <span className="w-4 rounded-t-md bg-primary-600 animate-bar-3" style={{ height: '45%' }} />
      </div>
      <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">assessments · published to your section</span>
    </div>
  );
}

const FEATURES = [
  { Visual: VAnnouncements, title: 'Announcements', text: 'Pinned notices, instant delivery, read receipts — the end of “check the group”.' },
  { Visual: VNotes, title: 'Notes & files', text: 'Lecture notes with cloud uploads — any file type, organized by subject.' },
  { Visual: VAssignments, title: 'Assignments', text: 'Deadlines, instructions and student submissions — all in one place, on time.' },
  { Visual: VTimetable, title: 'Daily timetable', text: 'A calendar day-by-day schedule with rooms, plus live next-class countdown.' },
  { Visual: VAttendance, title: 'QR attendance', text: 'CR opens a session, students scan — verified presence in seconds.' },
  { Visual: VMarks, title: 'Marks & assessments', text: 'Assessments, marks and results published straight to your section.' },
];

function FeatureCard({ Visual, title, text }) {
  return (
    <StaggerItem>
      <div className="group h-full overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-[0_1px_2px_rgb(16_24_40/0.04)] transition-all duration-300 hover:-translate-y-1 hover:border-primary-200 hover:shadow-[0_18px_44px_-14px_rgb(37_99_235/0.25)]">
        <div className="relative h-32 border-b border-slate-100 bg-gradient-to-b from-slate-50/80 to-white">
          <Visual />
        </div>
        <div className="p-6">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-900">{title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">{text}</p>
        </div>
      </div>
    </StaggerItem>
  );
}

function Features() {
  return (
    <section id="features" className="relative bg-slate-50/60 py-20 lg:py-28">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-primary-50/50 to-transparent" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary-600">Features</p>
          <h2 className="mt-3 max-w-2xl text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Everything a section needs, in one place.
          </h2>
          <p className="mt-4 max-w-2xl text-slate-600">
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


/* =========================== STATS BAND ============================ *
 *  Count-up numbers — the page's scale at a glance, zero paragraphs.
 * */
function CountUp({ to, suffix = '', duration = 1300 }) {
  const ref = useRef(null);
  const started = useRef(false);
  const [val, setVal] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !started.current) {
        started.current = true;
        const t0 = performance.now();
        const tick = (t) => {
          const p = Math.min((t - t0) / duration, 1);
          setVal(Math.round(to * (1 - Math.pow(1 - p, 3))));
          if (p < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        io.disconnect();
      }
    }, { threshold: 0.35 });
    io.observe(el);
    return () => { io.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [to, duration]);

  return <span ref={ref}>{val}{suffix}</span>;
}

const STATS = [
  { n: 6, suffix: '', label: 'core modules' },
  { n: 3, suffix: '', label: 'role portals' },
  { n: 10, suffix: ' MB', label: 'per file upload' },
  { n: 100, suffix: '%', label: 'section-isolated data' },
];

function StatsBand() {
  return (
    <div className="relative mx-auto mt-16 grid w-full max-w-7xl grid-cols-2 gap-8 border-t border-slate-200/70 px-4 pt-10 sm:grid-cols-4 sm:px-6 lg:px-8">
      {STATS.map((st, i) => (
        <Reveal key={st.label} delay={i * 0.07}>
          <p className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            <CountUp to={st.n} suffix={st.suffix} />
          </p>
          <p className="mt-1 text-sm text-slate-600">{st.label}</p>
        </Reveal>
      ))}
    </div>
  );
}

/* =========================== WORKFLOW ============================== *
 *  Admin -> CR -> Student pipeline with packets traveling the wires.
 * */
function WorkflowStep({ icon: Icon, kicker, label }) {
  return (
    <div className="flex h-full w-full flex-col items-center rounded-2xl border border-slate-200/90 bg-white px-6 py-8 text-center shadow-[0_1px_2px_rgb(16_24_40/0.04)] transition-all duration-300 hover:-translate-y-1 hover:border-primary-200 hover:shadow-[0_18px_44px_-14px_rgb(37_99_235/0.25)]">
      <span className="relative grid size-16 place-items-center rounded-2xl bg-primary-50 text-primary-600">
        <span className="absolute inset-0 rounded-2xl border-2 border-primary-300 animate-live-pulse" aria-hidden="true" />
        <Icon className="size-7 animate-icon-wiggle" />
      </span>
      <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.18em] text-primary-600">{kicker}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{label}</p>
    </div>
  );
}

function Connector() {
  return (
    <div className="hidden items-center lg:flex lg:w-16" aria-hidden="true">
      <span className="relative h-0.5 w-full rounded bg-primary-100">
        <span className="absolute -top-[3px] left-0 size-2 rounded-full bg-primary-500 animate-dot-travel" />
        <span className="absolute -top-[3px] left-0 size-2 rounded-full bg-sky-400 animate-dot-travel" style={{ animationDelay: '1.4s' }} />
      </span>
    </div>
  );
}

function Workflow() {
  return (
    <section id="how" className="relative py-20 lg:py-28">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary-600">How it works</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Provision. Publish. Delivered.</h2>
        </Reveal>
        <div className="mt-12 grid items-stretch gap-5 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <WorkflowStep icon={IconBuilding} kicker="Admin" label="Sets up your section & accounts" />
          <Connector />
          <WorkflowStep icon={IconMegaphone} kicker="CR" label="Posts once — announcements, notes, marks" />
          <Connector />
          <WorkflowStep icon={IconBell} kicker="Student" label="Receives everything, instantly" />
        </div>
      </div>
    </section>
  );
}

/* ====================== INSTANT DELIVERY (PHONE) =================== *
 *  A phone that keeps receiving — the delivery promise, animated.
 * */
const NOTIFS = [
  { icon: IconMegaphone, tone: 'bg-amber-50 text-amber-600', title: 'New announcement', body: 'Quiz — Wednesday, room B-204', time: 'now' },
  { icon: IconFileText, tone: 'bg-violet-50 text-violet-600', title: 'Notes uploaded', body: 'AI — Lecture 3.pdf', time: '1m' },
  { icon: IconQr, tone: 'bg-primary-50 text-primary-600', title: 'Attendance live', body: 'QR session open — scan to mark', time: '2m' },
  { icon: IconCheckCircle, tone: 'bg-emerald-50 text-emerald-600', title: 'Marks published', body: 'Assessment 1 — now visible', time: '4m' },
];

function PhoneDelivery() {
  return (
    <section className="relative overflow-hidden bg-slate-50/60 py-20 lg:py-28">
      <div className="pointer-events-none absolute -left-24 bottom-0 size-[360px] rounded-full bg-sky-200/40 blur-[110px] animate-aurora-b" aria-hidden="true" />
      <div className="relative mx-auto grid w-full max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
        <Reveal className="order-2 lg:order-1">
          <div className="relative mx-auto w-[288px] sm:w-[310px]">
            <div className="animate-float overflow-hidden rounded-[2.5rem] border-[8px] border-slate-800 bg-white shadow-[0_40px_90px_-30px_rgb(16_24_40/0.4)]">
              <div className="flex items-center justify-between bg-slate-50/80 px-5 py-2 text-[10px] font-medium text-slate-500">
                <span>9:41</span>
                <span className="h-4 w-14 rounded-full bg-slate-800" aria-hidden="true" />
                <span>PKT</span>
              </div>
              <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
                <IconBell className="size-4 text-primary-600 animate-icon-wiggle" />
                <p className="text-xs font-semibold text-slate-900">Notifications</p>
                <span className="ml-auto grid size-5 place-items-center rounded-full bg-primary-600 text-[10px] font-bold text-white">4</span>
              </div>
              <div className="h-[440px] space-y-2.5 p-3.5">
                {NOTIFS.map((n, i) => (
                  <div
                    key={n.title}
                    className={`flex items-center gap-3 rounded-xl border border-slate-200/80 bg-white p-3 shadow-[0_1px_3px_rgb(16_24_40/0.05)] animate-notif-${i + 1}`}
                  >
                    <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${n.tone}`}>
                      <n.icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-slate-900">{n.title}</p>
                      <p className="truncate text-[11px] text-slate-500">{n.body}</p>
                    </div>
                    <span className="text-[10px] text-slate-400">{n.time}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
        <div className="order-1 lg:order-2">
          <Reveal>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary-600">Instant delivery</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Posted once. Delivered everywhere.</h2>
            <p className="mt-4 max-w-md text-slate-600">
              The moment your CR posts, every student in the section sees it — announcements, files, attendance and marks, without a single forwarded message.
            </p>
            <div className="mt-6 flex flex-wrap gap-2.5">
              {['No forwarding', 'No missed messages', 'Read receipts'].map((chip) => (
                <span key={chip} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700">
                  <IconCheck className="size-3.5 text-emerald-500" /> {chip}
                </span>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ====================== FILE MARQUEE =============================== *
 *  Infinite scroll of everything your class shares. Pure CSS.
 * */
const FILE_TYPES = ['PDF', 'DOCX', 'PPTX', 'XLSX', 'CSV', 'PNG', 'JPG', 'GIF', 'ZIP', 'RAR', '7Z', 'MP3', 'WAV', 'MP4', 'WEBM'];

function FileMarquee() {
  return (
    <section className="relative py-14 lg:py-16" aria-label="Supported file types">
      <div className="mx-auto mb-8 w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <p className="text-center text-sm font-medium text-slate-600">
            Every file your class shares — <span className="font-semibold text-slate-900">up to 10 MB each, stored in the cloud</span>
          </p>
        </Reveal>
      </div>
      <div className="overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
        <div className="animate-marquee flex w-max">
          {[...FILE_TYPES, ...FILE_TYPES].map((t, i) => (
            <span key={i} className="mr-3 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-bold tracking-wide text-slate-600 shadow-[0_1px_2px_rgb(16_24_40/0.05)]">
              <IconFileText className="size-3.5 text-primary-500" /> {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =========================== ROLES ================================= */
const ROLES = [
  {
    icon: IconUserSquare, name: 'ADMIN', accent: 'Administrator',
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
      <div className="pointer-events-none absolute inset-x-0 top-1/3 h-64 bg-primary-100/40 blur-[120px]" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary-600">Portals</p>
          <h2 className="mt-3 max-w-2xl text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Three portals. One system.
          </h2>
          <p className="mt-4 max-w-2xl text-slate-600">
            Strict role separation — everyone sees exactly what they need, and nothing they shouldn&apos;t.
          </p>
        </Reveal>
        <Stagger className="mt-12 grid gap-5 lg:grid-cols-3">
          {ROLES.map((r) => (
            <StaggerItem key={r.name}>
              <div className="h-full rounded-2xl border border-slate-200/90 bg-white p-7 shadow-[0_1px_2px_rgb(16_24_40/0.04)] transition-all duration-300 hover:-translate-y-1 hover:border-primary-200 hover:shadow-[0_18px_44px_-14px_rgb(37_99_235/0.25)]">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl bg-primary-50 text-primary-600">
                    <r.icon className="size-5" />
                  </span>
                  <div>
                    <h3 className="text-sm font-bold tracking-widest text-slate-900">{r.name}</h3>
                    <p className="text-xs text-slate-500">{r.accent}</p>
                  </div>
                </div>
                <ul className="mt-5 space-y-2.5">
                  {r.lines.map((l) => (
                    <li key={l} className="flex items-start gap-2.5 text-sm text-slate-600">
                      <IconPlus className="mt-0.5 size-3.5 shrink-0 text-primary-500" aria-hidden="true" />
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
    <div className={`overflow-hidden rounded-2xl border bg-white transition-colors ${open ? 'border-primary-200 shadow-[0_10px_32px_-12px_rgb(37_99_235/0.18)]' : 'border-slate-200'}`}>
      <button
        type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
      >
        <span className="text-sm font-semibold text-slate-900 sm:text-base">{q}</span>
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-full border transition-all duration-300 ${open ? 'rotate-45 border-primary-200 bg-primary-50 text-primary-600' : 'border-slate-200 text-slate-500'}`}
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
            <p className="px-6 pb-6 text-sm leading-relaxed text-slate-600">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="relative bg-slate-50/60 py-20 lg:py-28">
      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary-600">FAQ</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Questions, answered.</h2>
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
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary-700 via-primary-600 to-blue-500 px-6 py-14 text-center shadow-[0_32px_80px_-20px_rgb(37_99_235/0.5)] sm:px-12">
            <div className="pointer-events-none absolute -left-16 -top-16 size-64 rounded-full bg-white/15 blur-3xl animate-aurora-a" aria-hidden="true" />
            <div className="pointer-events-none absolute -bottom-20 -right-10 size-72 rounded-full bg-sky-300/25 blur-3xl animate-aurora-b" aria-hidden="true" />
            <h2 className="relative mx-auto max-w-2xl text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Move your class off WhatsApp — <span className="text-sky-200">today.</span>
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-blue-100">
              Your admin and CR already have accounts. Sign in and see your section organized.
            </p>
            <Link
              to="/login"
              className="relative mt-8 inline-flex items-center gap-2 rounded-full bg-white px-7 py-3.5 text-sm font-semibold text-primary-700 shadow-[0_14px_36px_rgb(16_24_40/0.3)] transition-all hover:bg-blue-50"
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
    <footer className="border-t border-slate-200 py-12">
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-8 px-4 sm:px-6 md:flex-row lg:px-8">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-primary-600 text-sm font-bold text-white">IU</span>
          <div>
            <p className="text-sm font-semibold tracking-widest text-slate-900">IUB CLASS MANAGEMENT</p>
            <p className="text-xs text-slate-500">Class, handled.</p>
          </div>
        </div>
        <nav className="flex flex-wrap items-center justify-center gap-x-7 gap-y-2" aria-label="Footer">
          {NAV_LINKS.map((l) => (
            <button key={l.id} type="button" onClick={() => scrollTo(l.id)} className="text-sm text-slate-600 transition-colors hover:text-primary-600">
              {l.label}
            </button>
          ))}
          <Link to="/login" className="text-sm text-slate-600 transition-colors hover:text-primary-600">Sign in</Link>
          <Link to="/terms" className="text-sm text-slate-600 transition-colors hover:text-primary-600">Terms</Link>
          <Link to="/privacy" className="text-sm text-slate-600 transition-colors hover:text-primary-600">Privacy</Link>
        </nav>
        <p className="text-xs text-slate-500">© 2026 IUB Class Management. All rights reserved.</p>
      </div>
    </footer>
  );
}

/* =========================== PAGE ================================== */
export default function Landing() {
  return (
    <div className="min-h-dvh bg-white text-slate-900 antialiased">
      <Navbar />
      <main>
        <Hero />
        <Features />
        <Workflow />
        <PhoneDelivery />
        <FileMarquee />
        <Roles />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
