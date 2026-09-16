import { Link } from 'react-router-dom';
import { FadeIn } from '../components/motion/primitives.jsx';
import { IconArrowRight, IconChevronLeft } from '../components/icons.jsx';

/* ------------------------------------------------------------------ *
 *  Terms & Conditions — public legal page, white premium style.
 * ------------------------------------------------------------------ */

const UPDATED = 'September 15, 2026';

const SECTIONS = [
  {
    h: '1. Acceptance of terms',
    p: [
      'By accessing or using T3M (Tri3M) ("the Service"), you agree to be bound by these Terms & Conditions. If you do not agree, please do not use the Service.',
      'The Service is provided for sections of The Islamia University of Bahawalpur and is operated on behalf of the section admin and class representative (CR).',
    ],
  },
  {
    h: '2. Accounts & eligibility',
    p: [
      'Accounts are not open for public registration. The system admin provisions admin and CR accounts; CRs and students activate their accounts with a one-time code sent to their email address.',
      'You are responsible for keeping your password confidential. Notify your admin or CR immediately if you suspect unauthorized access to your account.',
    ],
  },
  {
    h: '3. Acceptable use',
    p: [
      'The Service is for lawful academic communication only. You may not post content that is defamatory, abusive, misleading, infringing, or unlawful, or upload files that contain malware or malicious code.',
      'You may not attempt to access data belonging to another section, another user, or any part of the system outside your assigned role and section.',
    ],
  },
  {
    h: '4. Content & files',
    p: [
      'Content posted by a CR (announcements, notes, assignments, timetable, marks, attendance) is scoped to their section. You retain ownership of content you post; by posting it, you grant other members of your section permission to view and download it through the Service.',
      'Uploaded files are limited to 10 MB per file. The Service supports common academic file types (documents, slides, sheets, images, archives, audio and video).',
    ],
  },
  {
    h: '5. Availability & changes',
    p: [
      'The Service is provided on a best-effort, free basis. We may modify, suspend, or discontinue any part of the Service at any time, and may update these terms — material changes will be reflected by the "last updated" date above.',
    ],
  },
  {
    h: '6. Disclaimer & limitation of liability',
    p: [
      'The Service is provided "as is" without warranties of any kind. We are not liable for academic consequences of missed announcements or deadlines, loss of uploaded content, or any indirect or incidental damages arising from use of the Service.',
      'Your CR and section admin are the authoritative source for official academic information.',
    ],
  },
  {
    h: '7. Contact',
    p: [
      'Questions about these terms can be raised with your section admin or CR, who can pass them to the operators of the Service.',
    ],
  },
];

export default function Terms() {
  return (
    <div className="min-h-dvh bg-white text-slate-900 antialiased">
      <div className="hero-dot-grid pointer-events-none absolute inset-x-0 top-0 h-64" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-3xl px-4 py-14 sm:px-6 lg:px-8">
        <FadeIn>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 transition-colors hover:text-primary-700"
          >
            <IconChevronLeft className="size-4" /> Back to home
          </Link>

          <p className="mt-10 text-xs font-bold uppercase tracking-[0.2em] text-primary-600">Legal</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Terms &amp; Conditions</h1>
          <p className="mt-3 text-sm text-slate-500">Last updated: {UPDATED}</p>

          <div className="mt-10 space-y-9">
            {SECTIONS.map((s) => (
              <section key={s.h}>
                <h2 className="text-base font-semibold text-slate-900">{s.h}</h2>
                {s.p.map((para) => (
                  <p key={para.slice(0, 24)} className="mt-2.5 text-sm leading-relaxed text-slate-600">{para}</p>
                ))}
              </section>
            ))}
          </div>

          <div className="mt-12 rounded-2xl border border-primary-100 bg-primary-50/60 p-6">
            <p className="text-sm font-semibold text-slate-900">Also see</p>
            <p className="mt-1 text-sm text-slate-600">
              How we handle your data is described in our{' '}
              <Link to="/privacy" className="font-medium text-primary-600 hover:text-primary-700">
                Privacy Policy
              </Link>
              .
            </p>
            <Link
              to="/"
              className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-primary-600 hover:text-primary-700"
            >
              Continue to the home page <IconArrowRight className="size-4" />
            </Link>
          </div>
        </FadeIn>
      </div>
    </div>
  );
}
