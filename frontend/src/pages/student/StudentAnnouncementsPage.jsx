import { useState } from 'react';
import { studentApi } from '../../api/student.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { timeAgo, formatDate } from '../../admin/format.js';
import { PageHeader, SuccessFlash } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { Spinner } from '../../components/ui/Spinner.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import { IconMegaphone, IconFileText } from '../../components/icons.jsx';

/** Read-only announcements — the CR authors these; students never modify. */
export default function StudentAnnouncementsPage() {
  const { user } = useAuth();
  const section = user?.section;
  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.announcements.list({ page: 1, limit: 30 }),
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
      const res = await studentApi.announcements.get(id);
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
        title="Announcements"
        description={`Updates posted by your CR for Section ${section.name}.`}
      />

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <div className="space-y-3" role="status" aria-label="Loading announcements">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl border border-slate-200/60 bg-slate-100/60" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconMegaphone className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">No announcements yet.</h3>
          <p className="mt-1 text-sm text-slate-500">When your CR posts an update it will appear here.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a._id}>
              <button
                type="button"
                onClick={() => openDetail(a._id)}
                className="w-full rounded-2xl border border-slate-200/80 bg-white p-5 text-left shadow-soft transition-shadow hover:shadow-lift"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-slate-900">{a.title}</h3>
                  {a.pinned && <Badge variant="primary">Pinned</Badge>}
                </div>
                <p className="mt-1.5 line-clamp-2 text-sm text-slate-600">{a.content}</p>
                <p className="mt-2.5 text-xs text-slate-400">{timeAgo(a.createdAt)}</p>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal open={openId != null} onClose={() => setOpenId(null)} title="Announcement">
        {detailLoading ? (
          <div className="flex items-center justify-center py-10" role="status"><Spinner /></div>
        ) : detailError ? (
          <Alert variant="danger"><p className="font-medium">{detailError.message}</p></Alert>
        ) : detail ? (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-base font-semibold text-slate-900">{detail.title}</h3>
              {detail.pinned && <Badge variant="primary">Pinned</Badge>}
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{detail.content}</p>
            <p className="text-xs text-slate-400">Posted {formatDate(detail.createdAt)}</p>
            {(detail.attachments?.length ?? 0) > 0 && (
              <div className="border-t border-slate-100 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Attachments</p>
                <ul className="mt-2 space-y-1.5">
                  {detail.attachments.map((f) => (
                    <li key={f._id ?? f.publicId}>
                      <a
                        href={f.url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700 hover:underline"
                      >
                        <IconFileText className="size-4" />
                        {f.originalName ?? 'Attachment'}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
