/** Small inline empty state for dashboard list cards — an icon, one line of
 *  copy, optional inline link. Quieter than the full EmptyState. */
export function MiniEmpty({ icon: Icon = null, text, link = null }) {
  return (
    <div className="flex items-center justify-center gap-2.5 rounded-xl bg-slate-50/80 px-4 py-6 text-sm text-slate-500">
      {Icon && <Icon className="size-4.5 shrink-0 text-slate-400" aria-hidden="true" />}
      <span>{text}</span>
      {link}
    </div>
  );
}
