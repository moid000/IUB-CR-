/** Calm, consistent unread language shared by announcements, assignments and notes. */
export function NewBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-primary-700">
      <span className="size-1.5 rounded-full bg-primary-600" aria-hidden="true" />
      New
    </span>
  );
}

export function NewUpdatesDivider({ count }) {
  if (!count) return null;
  return (
    <div className="flex items-center gap-3 py-1" role="separator" aria-label={`${count} new update${count === 1 ? '' : 's'}`}>
      <span className="h-px flex-1 bg-primary-200" />
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-primary-600">
        {count} new update{count === 1 ? '' : 's'}
      </span>
      <span className="h-px flex-1 bg-primary-200" />
    </div>
  );
}

export function EarlierDivider() {
  return (
    <div className="flex items-center gap-3 py-1" role="separator" aria-label="Earlier updates">
      <span className="h-px flex-1 bg-slate-200" />
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Earlier</span>
      <span className="h-px flex-1 bg-slate-200" />
    </div>
  );
}

export function NewRail() {
  return <span className="absolute inset-y-0 left-0 w-1 bg-primary-600" aria-hidden="true" />;
}
