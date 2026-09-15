import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Brand } from '../components/Brand.jsx';
import { Button } from '../components/ui/Button.jsx';
import {
  FadeIn, Reveal, Stagger, StaggerItem, EASE,
} from '../components/motion/primitives.jsx';
import {
  IconGrid, IconBuilding, IconCalendar, IconLayers, IconUserSquare, IconGraduation,
  IconMegaphone, IconFileText, IconClipboard, IconClock, IconQr, IconCheckCircle,
  IconBell, IconMenu, IconX, IconArrowRight, IconCheck,
} from '../components/icons.jsx';

/* ------------------------------------------------------------------ *
 *  Landing page — the public face of IUB Class Management.
 *  Calm, confident, truthful. No fake numbers, no stock art:
 *  every visual is built from the product's own component language.
 * ------------------------------------------------------------------ */

const NAV_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#roles', label: 'Roles' },
  { href: '#security', label: 'Security' },
];

/** Sticky navbar — transparent over the hero, frosted white once you scroll. */
function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-all duration-300 ${
        scrolled || open
          ? 'border-b border-slate-200/70 bg-white/80 shadow-sm backdrop-blur-md'
          : 'border-b border-transparent bg-transparent'
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6" aria-label="Main">
        <Link to="/" className="rounded-lg" aria-label="IUB Class Management home">
          <Brand />
        </Link>

        {/* Desktop links */}
        <div className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100/70 hover:text-slate-900"
            >
              {label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-2.5 md:flex">
          <Link to="/login"><Button variant="secondary" size="sm">Log in</Button></Link>
          <Link to="/login"><Button size="sm" icon={IconArrowRight}>Get started</Button></Link>
        </div>

        {/* Mobile toggle */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="rounded-lg p-2 text-slate-600 transition-colors hover:bg-slate-100 md:hidden"
        >
          {open ? <IconX className="size-5" /> : <IconMenu className="size-5" />}
        </button>
      </nav>

      {/* Mobile panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="overflow-hidden border-t border-slate-200/70 bg-white/95 backdrop-blur-md md:hidden"
          >
            <div className="space-y-1 px-4 py-4">
              {NAV_LINKS.map(({ href, label }) => (
                <a
                  key={href}
                  href={href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  {label}
                </a>
              ))}
              <div className="flex gap-2.5 pt-3">
                <Link to="/login" className="flex-1"><Button variant="secondary" className="w-full">Log in</Button></Link>
                <Link to="/login" className="flex-1"><Button className="w-full">Get started</Button></Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

/* --------------------------- Hero preview --------------------------- *
 * A layered, illustrative product mock — same components, sample data,
 * clearly not live statistics. */

function HeroPreview() {
  return (
    <div className="relative mx-auto w-full max-w-4xl" aria-hidden="true">
      {/* glow bed */}
      <div className="absolute -inset-x-8 top-8 bottom-0 rounded-[2rem] bg-gradient-to-b from-primary-100/70 via-primary-50/40 to-transparent blur-2xl" />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, delay: 0.15, ease: EASE }}
        className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 shadow-lift backdrop-blur-sm"
      >
        {/* window bar */}
        <div className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-3">
          <span className="size-2.5 rounded-full bg-slate-200" />
          <span className="size-2.5 rounded-full bg-slate-200" />
          <span className="size-2.5 rounded-full bg-slate-200" />
          <span className="ml-3 text-[11px] font-medium text-slate-400">iubcr.vercel.app — class dashboard</span>
        </div>

        <div className="flex">
          {/* mini sidebar */}
          <div className="hidden w-40 shrink-0 flex-col gap-1 border-r border-slate-100 bg-slate-50/60 p-3 sm:flex">
            {['Dashboard', 'Subjects', 'Announcements', 'Assignments', 'Timetable', 'Marks'].map((l, i) => (
              <div key={l} className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] font-medium ${i === 0 ? 'bg-primary-50 text-primary-700' : 'text-slate-400'}`}>
                <span className={`size-1.5 rounded-full ${i === 0 ? 'bg-primary-500' : 'bg-slate-300'}`} />
                {l}
              </div>
            ))}
          </div>

          {/* content */}
          <div className="min-w-0 flex-1 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-slate-800">Section 1M · Fall 2026</div>
                <div className="mt-0.5 text-[10px] text-slate-400">Artificial Intelligence</div>
              </div>
              <div className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700">
                Next class in 24:31
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2.5">
              {[
                { label: 'Subjects', value: '6' },
                { label: 'Assignments', value: '3' },
                { label: 'Notes', value: '12' },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
                  <div className="text-[10px] font-medium text-slate-400">{s.label}</div>
                  <div className="mt-1 text-lg font-semibold tracking-tight text-slate-800">{s.value}</div>
                </div>
              ))}
            </div>

            <div className="mt-3 space-y-2">
              {[
                { time: '09:00', name: 'Programming Fundamentals', room: 'Lab 2' },
                { time: '11:00', name: 'Calculus', room: 'Room 14' },
              ].map((c) => (
                <div key={c.time} className="flex items-center gap-3 rounded-xl border border-slate-100 bg-white px-3 py-2.5 shadow-sm">
                  <span className="rounded-lg bg-primary-50 px-2 py-1 text-[10px] font-semibold text-primary-700">{c.time}</span>
                  <span className="truncate text-[11px] font-medium text-slate-700">{c.name}</span>
                  <span className="ml-auto hidden text-[10px] text-slate-400 sm:block">{c.room}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </motion.div>

      {/* floating announcement chip */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.45, ease: EASE }}
        className="absolute -bottom-5 left-4 flex items-center gap-2.5 rounded-xl border border-slate-200/80 bg-white/95 px-3.5 py-2.5 shadow-lift backdrop-blur-sm sm:left-10"
      >
        <span className="grid size-7 place-items-center rounded-lg bg-primary-600 text-white">
          <IconMegaphone className="size-3.5" />
        </span>
        <div>
          <div className="text-[11px] font-semibold text-slate-800">New announcement</div>
          <div className="text-[10px] text-slate-400">Your CR posted in 1M</div>
        </div>
      </motion.div>

      {/* floating marks chip */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.6, ease: EASE }}
        className="absolute -bottom-5 right-4 hidden items-center gap-2.5 rounded-xl border border-slate-200/80 bg-white/95 px-3.5 py-2.5 shadow-lift backdrop-blur-sm sm:right-10 sm:flex"
      >
        <span className="grid size-7 place-items-center rounded-lg bg-emerald-500 text-white">
          <IconCheckCircle className="size-3.5" />
        </span>
        <div>
          <div className="text-[11px] font-semibold text-slate-800">Quiz marks posted</div>
          <div className="text-[10px] text-slate-400">Assessment results are in</div>
        </div>
      </motion.div>
    </div>
  );
}

/* ------------------------------ Sections ------------------------------ */

const FEATURES = [
  { icon: IconBuilding, title: 'Academic Management', desc: 'Departments, sessions, sections and subjects — the full academic hierarchy, always consistent.' },
  { icon: IconMegaphone, title: 'Announcements', desc: 'Your CR posts class updates with file attachments. Nobody misses what matters.' },
  { icon: IconFileText, title: 'Notes', desc: 'Lecture notes and reference material, organized by subject and always in reach.' },
  { icon: IconClipboard, title: 'Assignments', desc: 'Publish assignments, collect submissions with files, and track who has submitted.' },
  { icon: IconClock, title: 'Timetable', desc: 'A daily class schedule with rooms, copy-a-day tools, and a live next-class countdown.' },
  { icon: IconQr, title: 'Attendance', desc: 'Reliable session-based attendance for your section — marked once, visible to students.' },
  { icon: IconCheckCircle, title: 'Marks & Results', desc: 'Assessments and marks entered by your CR, surfaced per subject for every student.' },
  { icon: IconBell, title: 'Notifications', desc: 'Class reminders and updates land where students actually look — inside the app.' },
  { icon: IconGraduation, title: 'Role-Based Access', desc: 'Admins manage the institution, CRs run the class, students stay informed — each in their own lane.' },
];

function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary-600">Everything in one place</p>
        <h2 className="mt-3 text-display-sm text-slate-900">Built around how your class actually works</h2>
        <p className="mt-4 text-base leading-relaxed text-slate-500">
          One workspace for announcements, notes, assignments, timetable, attendance and results — scoped to your section, always current.
        </p>
      </Reveal>

      <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" gap={0.05}>
        {FEATURES.map(({ icon: Icon, title, desc }) => (
          <StaggerItem key={title}>
            <div className="group h-full rounded-2xl border border-slate-200/70 bg-white/80 p-6 shadow-soft backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:border-slate-300/80 hover:shadow-lift">
              <span className="grid size-10 place-items-center rounded-xl bg-primary-50 text-primary-600 transition-colors group-hover:bg-primary-600 group-hover:text-white">
                <Icon className="size-5" />
              </span>
              <h3 className="mt-4 text-[15px] font-semibold tracking-tight text-slate-900">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{desc}</p>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { icon: IconUserSquare, role: 'Admin', desc: 'Sets up departments, sessions and sections, and appoints a CR for each section.' },
    { icon: IconGraduation, role: 'CR', desc: 'Runs the class — students, subjects, announcements, timetable, attendance and marks.' },
    { icon: IconGrid, role: 'Student', desc: 'Follows everything in a clean portal built for their phone: announcements, submissions, results.' },
  ];
  return (
    <section id="how-it-works" className="border-y border-slate-200/60 bg-white/60 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary-600">How it works</p>
          <h2 className="mt-3 text-display-sm text-slate-900">A clear chain of responsibility</h2>
          <p className="mt-4 text-base leading-relaxed text-slate-500">
            Every class has one admin, one CR, and its students. Information flows down — accountability flows up.
          </p>
        </Reveal>

        <Stagger className="mt-14 grid gap-6 md:grid-cols-3" gap={0.12}>
          {steps.map(({ icon: Icon, role, desc }, i) => (
            <StaggerItem key={role} className="relative">
              {i < steps.length - 1 && (
                <div className="absolute left-full top-10 hidden w-6 justify-center text-slate-300 md:flex" aria-hidden="true">
                  <IconArrowRight className="size-4" />
                </div>
              )}
              <div className="h-full rounded-2xl border border-slate-200/70 bg-white p-6 text-center shadow-soft">
                <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-slate-900 text-white shadow-sm">
                  <Icon className="size-5" />
                </div>
                <div className="mt-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">Step {i + 1}</div>
                <h3 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">{role}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">{desc}</p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}

function Roles() {
  const roles = [
    {
      icon: IconBuilding, name: 'ADMIN', tagline: 'The institution, organized',
      points: ['Full academic hierarchy — departments to subjects', 'Create and manage CR accounts', 'Oversight of every section\'s activity'],
    },
    {
      icon: IconGraduation, name: 'CR', tagline: 'The class, run well',
      points: ['Onboard students into your section', 'Post announcements, notes and assignments', 'Timetable, attendance and marks in one place'],
    },
    {
      icon: IconGrid, name: 'STUDENT', tagline: 'The class, in your pocket',
      points: ['Announcements and notes, by subject', 'Submit assignments with files', 'Attendance record, marks and class reminders'],
    },
  ];
  return (
    <section id="roles" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary-600">One platform, three roles</p>
        <h2 className="mt-3 text-display-sm text-slate-900">Each role gets exactly what it needs</h2>
      </Reveal>

      <Stagger className="mt-12 grid gap-5 lg:grid-cols-3" gap={0.1}>
        {roles.map(({ icon: Icon, name, tagline, points }) => (
          <StaggerItem key={name}>
            <div className="flex h-full flex-col rounded-2xl border border-slate-200/70 bg-white/90 p-7 shadow-soft backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-lift">
              <div className="flex items-center gap-3">
                <span className="grid size-11 place-items-center rounded-xl bg-slate-900 text-white shadow-sm"><Icon className="size-5" /></span>
                <div>
                  <h3 className="text-sm font-bold tracking-[0.14em] text-slate-900">{name}</h3>
                  <p className="text-xs font-medium text-slate-400">{tagline}</p>
                </div>
              </div>
              <ul className="mt-6 space-y-3">
                {points.map((p) => (
                  <li key={p} className="flex items-start gap-2.5 text-sm leading-relaxed text-slate-600">
                    <IconCheck className="mt-0.5 size-4 shrink-0 text-primary-600" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

function Showcase() {
  return (
    <section className="border-y border-slate-200/60 bg-white/60 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl space-y-20 px-4 sm:px-6">
        {/* Timetable */}
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary-600">Timetable & reminders</p>
            <h2 className="mt-3 text-display-sm text-slate-900">Never wonder where your next class is</h2>
            <p className="mt-4 text-base leading-relaxed text-slate-500">
              A daily schedule with rooms, an at-a-glance countdown to your next class, and a reminder before it starts. CRs can plan a whole day in seconds — and copy it to another day when the routine repeats.
            </p>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-lift">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-800">Tuesday · Section 1M</div>
                <div className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-600">Ongoing</div>
              </div>
              <div className="mt-4 space-y-2.5" aria-hidden="true">
                {[
                  { t: '09:00', s: 'Programming Fundamentals', r: 'Lab 2', state: 'done' },
                  { t: '11:00', s: 'Calculus', r: 'Room 14', state: 'live' },
                  { t: '13:00', s: 'English Composition', r: 'Room 8', state: 'next' },
                ].map((c) => (
                  <div key={c.t} className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 ${
                    c.state === 'live' ? 'border-emerald-200 bg-emerald-50/50'
                    : c.state === 'next' ? 'border-primary-200 bg-primary-50/50' : 'border-slate-100 bg-white'}`}>
                    <span className={`text-xs font-semibold ${c.state === 'live' ? 'text-emerald-600' : c.state === 'next' ? 'text-primary-700' : 'text-slate-400'}`}>{c.t}</span>
                    <span className="truncate text-sm font-medium text-slate-700">{c.s}</span>
                    <span className="ml-auto text-xs text-slate-400">{c.r}</span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>

        {/* Assignments */}
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <Reveal delay={0.1} className="order-2 lg:order-1">
            <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-lift">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-800">Assignments</div>
                <div className="text-[11px] font-medium text-slate-400">Section 1M</div>
              </div>
              <div className="mt-4 space-y-2.5" aria-hidden="true">
                {[
                  { s: 'Programming Fundamentals', d: 'Lab task 3 — arrays', due: 'Due tomorrow', pct: 'w-2/3', tone: 'bg-primary-500' },
                  { s: 'Calculus', d: 'Worksheet 5', due: 'Due Friday', pct: 'w-1/3', tone: 'bg-emerald-500' },
                  { s: 'English', d: 'Essay draft', due: 'Graded', pct: 'w-full', tone: 'bg-slate-300' },
                ].map((a) => (
                  <div key={a.d} className="rounded-xl border border-slate-100 bg-white px-3.5 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-slate-700">{a.d}</span>
                      <span className="shrink-0 text-[11px] font-semibold text-slate-400">{a.due}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-400">{a.s}</div>
                    <div className="mt-2 h-1 rounded-full bg-slate-100">
                      <div className={`h-full rounded-full ${a.tone} ${a.pct}`} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
          <Reveal className="order-1 lg:order-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary-600">Assignments & submissions</p>
            <h2 className="mt-3 text-display-sm text-slate-900">From posting to grading, without the paper trail</h2>
            <p className="mt-4 text-base leading-relaxed text-slate-500">
              CRs publish assignments with deadlines and attachments. Students submit their files right from their phone. Submission progress and results stay visible to everyone who needs them.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Security() {
  const points = [
    { icon: IconUserSquare, title: 'Role-based access', desc: 'Admins, CRs and students each see only their own workspace — enforced on every request.' },
    { icon: IconLayers, title: 'Section isolation', desc: 'A student in section 1M never sees section 1L\'s announcements, notes or marks.' },
    { icon: IconBell, title: 'Verified accounts', desc: 'Accounts are activated through an email OTP flow — no self-assigned roles.' },
    { icon: IconGraduation, title: 'Controlled academic identity', desc: 'Roll numbers and sections are assigned by your CR and admin — students can\'t edit them.' },
  ];
  return (
    <section id="security" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary-600">Security & trust</p>
        <h2 className="mt-3 text-display-sm text-slate-900">Access is a privilege, not a guess</h2>
        <p className="mt-4 text-base leading-relaxed text-slate-500">
          The rules of the classroom apply to the software too — identity, roles and boundaries are enforced by the platform, not by good intentions.
        </p>
      </Reveal>

      <Stagger className="mt-12 grid gap-4 sm:grid-cols-2" gap={0.07}>
        {points.map(({ icon: Icon, title, desc }) => (
          <StaggerItem key={title}>
            <div className="flex h-full items-start gap-4 rounded-2xl border border-slate-200/70 bg-white/80 p-6 shadow-soft backdrop-blur-sm">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-white"><Icon className="size-4.5" /></span>
              <div>
                <h3 className="text-[15px] font-semibold tracking-tight text-slate-900">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-500">{desc}</p>
              </div>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

function FinalCTA() {
  return (
    <section className="px-4 pb-20 sm:px-6 sm:pb-28">
      <Reveal className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl bg-slate-900 px-6 py-16 text-center shadow-lift sm:px-16">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 hero-dot-grid opacity-[0.15]" />
        <div aria-hidden="true" className="pointer-events-none absolute -top-32 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-primary-500/25 blur-3xl" />
        <div className="relative">
          <h2 className="text-display-sm text-white">Ready to manage your class smarter?</h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-slate-300">
            Log in to your portal — or ask your class CR to onboard you.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to="/login"><Button size="lg" className="w-full sm:w-auto">Log in</Button></Link>
            <Link to="/login"><Button size="lg" variant="secondary" className="w-full border-white/15 bg-white/10 text-white hover:bg-white/20 sm:w-auto">Get started</Button></Link>
          </div>
          <p className="mt-5 text-xs text-slate-400">Accounts are provisioned by your university admin and class CR.</p>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-200/70 bg-white/70 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-4 py-10 sm:flex-row sm:px-6">
        <div className="flex flex-col items-center gap-2 sm:items-start">
          <Brand />
          <p className="text-xs text-slate-400">A class management workspace for IUB sections.</p>
        </div>
        <div className="flex items-center gap-5 text-sm">
          <Link to="/login" className="font-medium text-slate-500 transition-colors hover:text-slate-900">Log in</Link>
          <Link to="/cr/activate" className="font-medium text-slate-500 transition-colors hover:text-slate-900">CR activation</Link>
          <Link to="/student/activate" className="font-medium text-slate-500 transition-colors hover:text-slate-900">Student activation</Link>
        </div>
      </div>
      <div className="border-t border-slate-100 py-4 text-center text-xs text-slate-400">
        © {new Date().getFullYear()} IUB Class Management System
      </div>
    </footer>
  );
}

/* ------------------------------- Page ------------------------------- */

export default function Landing() {
  return (
    <div className="min-h-dvh bg-slate-50">
      <Navbar />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden pb-20 pt-28 sm:pb-24 sm:pt-36">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 hero-dot-grid [mask-image:radial-gradient(60%_50%_at_50%_20%,white,transparent)]" />
          <div aria-hidden="true" className="pointer-events-none absolute -top-24 left-1/2 h-96 w-[52rem] -translate-x-1/2 rounded-full bg-primary-100/70 blur-3xl" />

          <div className="relative mx-auto max-w-6xl px-4 text-center sm:px-6">
            <FadeIn>
              <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/80 px-3.5 py-1.5 text-xs font-medium text-slate-600 shadow-sm backdrop-blur-sm">
                <span className="size-1.5 rounded-full bg-primary-500" />
                For Islamia University of Bahawalpur classes
              </div>
            </FadeIn>

            <FadeIn delay={0.08}>
              <h1 className="mx-auto mt-6 max-w-3xl text-display text-slate-900">
                One smarter workspace for <span className="bg-gradient-to-r from-primary-600 to-primary-400 bg-clip-text text-transparent">IUB classes</span>.
              </h1>
            </FadeIn>

            <FadeIn delay={0.16}>
              <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-slate-500 sm:text-lg">
                Announcements, notes, assignments, timetable, attendance and marks — organized by section, managed by your CR, always in every student's pocket.
              </p>
            </FadeIn>

            <FadeIn delay={0.24}>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Link to="/login"><Button size="lg" icon={IconArrowRight} className="w-full sm:w-auto">Get started</Button></Link>
                <a href="#features"><Button size="lg" variant="secondary" className="w-full sm:w-auto">Explore features</Button></a>
              </div>
            </FadeIn>

            <div className="mt-14 sm:mt-20">
              <HeroPreview />
            </div>
          </div>
        </section>

        <Features />
        <HowItWorks />
        <Roles />
        <Showcase />
        <Security />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
