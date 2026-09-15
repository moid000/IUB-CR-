/**
 * Skeleton system — shimmer placeholders that mirror the real layout.
 * Structure appears instantly; content swaps in without layout shift.
 * Shimmer is a single background-position animation (GPU-friendly).
 */
export function Skeleton({ className = '' }) {
  return <div className={`skeleton-shimmer rounded-lg ${className}`} aria-hidden="true" />;
}

export function SkeletonText({ lines = 3, className = '' }) {
  const widths = ['w-full', 'w-5/6', 'w-2/3', 'w-1/2', 'w-1/3'];
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={`skeleton-shimmer h-3 rounded ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}

export function SkeletonAvatar({ className = 'size-10' }) {
  return <div className={`skeleton-shimmer rounded-full ${className}`} aria-hidden="true" />;
}

export function SkeletonCard({ rows = 2 }) {
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white/80 p-5 shadow-soft" aria-hidden="true">
      <div className="skeleton-shimmer h-4 w-1/3 rounded" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-shimmer mt-3 h-3 rounded bg-slate-200/70" style={{ width: `${70 - i * 15}%` }} />
      ))}
    </div>
  );
}

/** Stat card placeholder — number-first shape of the overview cards. */
export function SkeletonStat({ count = 4, className = '' }) {
  return (
    <div className={`grid grid-cols-2 gap-4 lg:grid-cols-${count} ${className}`} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-slate-200/70 bg-white/80 p-5 shadow-soft">
          <div className="skeleton-shimmer h-3 w-1/2 rounded" />
          <div className="skeleton-shimmer mt-3 h-7 w-1/3 rounded" />
        </div>
      ))}
    </div>
  );
}

/** Table placeholder — header band + rows, matching DataTable rhythm. */
export function SkeletonTable({ rows = 6, cols = 4 }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-soft" role="status" aria-label="Loading records">
      <div className="flex items-center gap-4 border-b border-slate-100 px-5 py-3.5">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="skeleton-shimmer h-3 rounded" style={{ width: `${100 / cols}%` }} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-5 py-3.5">
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={c}
              className={`skeleton-shimmer h-4 rounded ${c === 0 ? 'w-[28%]' : c === cols - 1 ? 'w-14' : 'flex-1'}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** List placeholder — for announcement/note feeds (mobile-first cards). */
export function SkeletonList({ items = 4 }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading items">
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="flex items-start gap-3.5 rounded-2xl border border-slate-200/70 bg-white/80 p-4 shadow-soft">
          <SkeletonAvatar className="size-10 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="skeleton-shimmer h-3.5 w-3/4 rounded" />
            <div className="skeleton-shimmer h-3 w-1/2 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Dashboard placeholder — header + stats + table, the overview page shape. */
export function SkeletonDashboard({ stats = 4 }) {
  return (
    <div role="status" aria-label="Loading dashboard">
      <div className="mb-6 space-y-2">
        <div className="skeleton-shimmer h-6 w-56 rounded" />
        <div className="skeleton-shimmer h-3.5 w-80 rounded" />
      </div>
      <SkeletonStat count={stats} className="mb-6" />
      <SkeletonTable rows={5} />
    </div>
  );
}

/** Compact plain rows — leading circle + text lines; for lists inside modals. */
export function SkeletonRows({ rows = 4, circle = true, className = '' }) {
  return (
    <div className={`space-y-3 ${className}`} role="status" aria-label="Loading list">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          {circle && <div className="skeleton-shimmer size-9 shrink-0 rounded-full" />}
          <div className="flex-1 space-y-2">
            <div className="skeleton-shimmer h-3.5 rounded w-3/5" />
            <div className="skeleton-shimmer h-3 rounded w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Compact table-shaped rows — for tabular content inside cards. */
export function SkeletonColumns({ rows = 5, className = '' }) {
  return (
    <div className={`space-y-3 ${className}`} role="status" aria-label="Loading table">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="skeleton-shimmer h-4 flex-1 rounded" />
          <div className="skeleton-shimmer hidden h-4 w-24 rounded sm:block" />
          <div className="skeleton-shimmer h-4 w-16 rounded" />
        </div>
      ))}
    </div>
  );
}
