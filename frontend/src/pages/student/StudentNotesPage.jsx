import { useState } from 'react';
import { studentApi } from '../../api/student.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { timeAgo, formatDate } from '../../admin/format.js';
import { PageHeader } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { Spinner } from '../../components/ui/Spinner.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import { IconFileText } from '../../components/icons.jsx';
import { FileList } from '../../components/files/FileList.jsx';

/** Read-only notes — section-scoped, archived notes follow backend visibility. */
export default function StudentNotesPage() {
  const { user } = useAuth();
  const section = user?.section;
  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.notes.list({ page: 1, limit: 30 }),
    []
  );
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  if (!section) return <NoSection />;

  const openDetail = async (id) => {
    setOpenId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await studentApi.notes.get(id);
      setDetail(res?.data ?? null);
    } catch (err) {
      setDetailError(err);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Notes"
        description={`Study notes shared by your CR for Section ${section.name}.`}
      />

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <div className="space-y-3" role="status" aria-label="Loading notes">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 skeleton-shimmer rounded-2xl border border-slate-200/60" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconFileText className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">No notes available yet.</h3>
          <p className="mt-1 text-sm text-slate-500">When your CR shares notes they will appear here.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((n) => (
            <li key={n._id}>
              <button
                type="button"
                onClick={() => openDetail(n._id)}
                className="w-full rounded-2xl border border-slate-200/80 bg-white p-5 text-left shadow-soft transition-shadow hover:shadow-lift"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-slate-900">{n.title}</h3>
                  {n.subject && <Badge variant="primary">{n.subject.name}</Badge>}
                </div>
                {n.content && <p className="mt-1.5 line-clamp-2 text-sm text-slate-600">{n.content}</p>}
                <p className="mt-2.5 text-xs text-slate-400">{timeAgo(n.createdAt)}</p>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal open={openId != null} onClose={() => setOpenId(null)} title="Note">
        {detailLoading ? (
          <div className="flex items-center justify-center py-10" role="status"><Spinner /></div>
        ) : detailError ? (
          <Alert variant="danger"><p className="font-medium">{detailError.message}</p></Alert>
        ) : detail ? (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-base font-semibold text-slate-900">{detail.title}</h3>
              {detail.subject && <Badge variant="primary">{detail.subject.name}</Badge>}
            </div>
            {detail.content && (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{detail.content}</p>
            )}
            <p className="text-xs text-slate-400">Shared {formatDate(detail.createdAt)}</p>
            {(detail.attachments?.length ?? 0) > 0 && (
              <div className="border-t border-slate-100 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Attachments</p>
                <div className="mt-2"><FileList files={detail.attachments} /></div>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
