import { Alert } from '../ui/Alert.jsx';
import { Button } from '../ui/Button.jsx';
import { EmptyState } from '../ui/EmptyState.jsx';
import { Skeleton } from '../ui/Skeleton.jsx';
import { IconChevronLeft, IconChevronRight, IconInbox } from '../icons.jsx';

/**
 * Reusable admin data table.
 * - compact, readable, hover rows
 * - skeleton loading / friendly error / intentional empty state
 * - optional pagination footer (server-side pagination contract)
 * - horizontal scroll only inside the table on small screens; columns can
 *   opt out per breakpoint via col.className (e.g. "hidden md:table-cell")
 */
export function DataTable({
  columns,
  rows,
  loading = false,
  error = null,
  onRetry,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyAction = null,
  pagination = null, // { page, limit, total, totalPages }
  onPageChange,
  rowKey = (r) => r._id,
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-soft">
      {error ? (
        <div className="p-6">
          <Alert variant="danger">
            <p className="font-medium">{error.message}</p>
          </Alert>
          {onRetry && (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
            </div>
          )}
        </div>
      ) : loading ? (
        <div className="p-4" role="status" aria-label="Loading records">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-2 py-3">
              <Skeleton className="h-5 flex-1" />
              <Skeleton className="hidden h-5 w-28 md:block" />
              <Skeleton className="hidden h-5 w-20 lg:block" />
              <Skeleton className="h-5 w-24" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-6">
          <EmptyState
            icon={<IconInbox className="size-10" />}
            title={emptyTitle}
            description={emptyDescription}
            action={emptyAction}
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200/80 bg-slate-50/60">
                  {columns.map((col) => (
                    <th key={col.key} scope="col" className={`whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 ${col.headerClassName ?? ''} ${col.className ?? ''}`}>
                      {col.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={rowKey(row)} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70 transition-colors">
                    {columns.map((col) => (
                      <td key={col.key} className={`px-4 py-3 align-middle text-slate-700 ${col.className ?? ''}`}>
                        {col.render ? col.render(row) : row[col.key] ?? '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pagination && pagination.totalPages > 1 && (
            <TablePagination pagination={pagination} onPageChange={onPageChange} />
          )}
        </>
      )}
    </div>
  );
}

function TablePagination({ pagination, onPageChange }) {
  const { page, limit, total, totalPages } = pagination;
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  return (
    <nav aria-label="Table pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
      <p className="text-xs text-slate-500">
        Showing <span className="font-medium text-slate-700">{from}–{to}</span> of{' '}
        <span className="font-medium text-slate-700">{total}</span>
      </p>
      <div className="flex items-center gap-1.5">
        <Button variant="secondary" size="sm" icon={IconChevronLeft} disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page">
          Prev
        </Button>
        <span className="px-2 text-xs font-medium text-slate-600" aria-current="page">
          {page} / {totalPages}
        </span>
        <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} aria-label="Next page">
          Next<IconChevronRight className="size-4" />
        </Button>
      </div>
    </nav>
  );
}
