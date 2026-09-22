
/** Empty state — a calm signpost, not a dead end.
 *  Icon in a soft chip, clear title, human explanation, optional action. */
export function EmptyState({ icon = null, title, description, action = null }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300/90 bg-white/60 px-6 py-14 text-center">
      {icon && (
        <div className="mb-4 grid size-12 place-items-center rounded-full border border-slate-200/80 bg-slate-50 text-slate-400">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-slate-500">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
