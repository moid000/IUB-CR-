import { Link } from 'react-router-dom';
import { FadeIn } from '../components/motion/primitives.jsx';
import { IconArrowRight, IconChevronLeft } from '../components/icons.jsx';

/* ------------------------------------------------------------------ *
 *  Privacy Policy — public legal page, white premium style.
 *  Reflects the real stack: JWT auth, MongoDB, Cloudinary file
 *  storage, Brevo transactional email. No ads, no trackers, no
 *  data selling.
 * ------------------------------------------------------------------ */

const UPDATED = 'September 15, 2026';

const SECTIONS = [
  {
    h: '1. Who we are & scope',
    p: [
      'IUB Class Management ("the Service") is a class portal for sections of The Islamia University of Bahawalpur. This policy explains what data the Service collects, why, and how it is handled.',
    ],
  },
  {
    h: '2. Data we collect',
    p: [
      'Account data: your name, email address, role (admin, CR or student), roll number (for students), and your section. Admin and CR accounts are provisioned by the system admin; student accounts are activated with a one-time code sent to your email.',
      'Content data: announcements, notes and files, assignments and submissions, timetable entries, attendance records, and marks — all scoped to your section.',
      'Security data: an authentication token stored on your device and password kept only as a secure hash. Password reset requests are delivered by email.',
    ],
  },
  {
    h: '3. How data is used',
    p: [
      'Data is used strictly to run your class portal: signing you in, showing you your section\u2019s content, delivering notifications, recording attendance, and publishing marks.',
      'We do not sell, rent, or share your personal data with advertisers or data brokers. There are no third-party trackers or advertising pixels in the Service.',
    ],
  },
  {
    h: '4. Storage & processors',
    p: [
      'The Service runs on serverless infrastructure (Vercel) with a managed database (MongoDB Atlas). Uploaded files and images are stored with Cloudinary. Transactional emails (activation codes, password resets) are delivered via Brevo.',
      'Each of these processors handles your data only to perform its function for the Service. Uploaded files are limited to 10 MB per file.',
    ],
  },
  {
    h: '5. Section isolation & access',
    p: [
      'Your content is isolated to your section: students only see data for their own section, and every role only sees the parts of the system relevant to that role.',
      'Your CR and the system admin can view, edit, or delete section content as needed to run the section.',
    ],
  },
  {
    h: '6. Retention',
    p: [
      'Data is kept while your section is active, and until your admin or CR deletes it (admins and CRs can delete announcements, files, assignments, marks and other records directly in the Service), or the Service is decommissioned.',
    ],
  },
  {
    h: '7. Your rights',
    p: [
      'You may request correction or deletion of your personal data by contacting your section admin or CR. You can change your own password and profile avatar at any time from your portal.',
    ],
  },
  {
    h: '8. Security',
    p: [
      'Passwords are stored as cryptographic hashes, never in plain text. Sessions use signed tokens. Access to the Service is over encrypted HTTPS connections.',
      'No system is perfectly secure; if a data incident ever occurs, affected users will be notified through the Service or by email.',
    ],
  },
  {
    h: '9. Changes & contact',
    p: [
      'We may update this policy as the Service evolves; material changes are reflected by the "last updated" date above. Questions can be raised with your section admin or CR.',
    ],
  },
];

export default function Privacy() {
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
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Privacy Policy</h1>
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
              The rules for using the Service are in our{' '}
              <Link to="/terms" className="font-medium text-primary-600 hover:text-primary-700">
                Terms &amp; Conditions
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
