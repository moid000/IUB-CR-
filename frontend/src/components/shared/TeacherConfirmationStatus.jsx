/** Read-only, server-authoritative status. No per-card API calls or animation. */
const labels = {
  queued: 'Contacting teacher',
  sending: 'Contacting teacher',
  awaiting: 'Awaiting teacher',
  confirmed: 'Teacher confirmed',
  declined: 'Teacher unavailable',
  failed: 'Confirmation delayed',
  none: 'Not requested',
};

const styles = {
  confirmed: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  declined: 'border-rose-200 bg-rose-50 text-rose-800',
  failed: 'border-amber-200 bg-amber-50 text-amber-800',
  awaiting: 'border-primary-100 bg-primary-50 text-primary-700',
  queued: 'border-slate-200 bg-slate-50 text-slate-600',
  sending: 'border-slate-200 bg-slate-50 text-slate-600',
  none: 'border-slate-200 bg-slate-50 text-slate-500',
};

export default function TeacherConfirmationStatus({ confirmation, compact = false }) {
  const status = confirmation?.status ?? 'none';
  // set manually by the CR (teacher confirmed on a phone call, no WhatsApp reply)
  const manual = Boolean(confirmation?.manualBy);
  const text = manual && (status === 'confirmed' || status === 'declined')
    ? `${labels[status]} · set by CR`
    : (labels[status] ?? labels.none);
  return (
    <span title={manual ? 'Teacher confirmed on a phone call — CR updated the status manually' : undefined} className={`inline-flex w-fit max-w-full items-center rounded-full border font-medium ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'} ${styles[status] ?? styles.none}`}>
      {text}
    </span>
  );
}

export const hasPendingTeacherResponse = (slots) => (slots ?? []).some(
  (s) => ['queued', 'sending', 'awaiting', 'failed'].includes(s.teacherConfirmation?.status)
);
