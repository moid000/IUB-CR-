import { useState } from 'react';
import { Skeleton, SkeletonText } from '../../components/ui/Skeleton.jsx';
import { studentApi } from '../../api/student.js';
import { useAdminQuery } from '../../admin/hooks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { timeAgo, formatDate } from '../../admin/format.js';
import { PageHeader } from '../../components/admin/controls.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { NoSection } from '../../student/NoSection.jsx';
import { IconMegaphone, IconFileText } from '../../components/icons.jsx';
import { FileList, FileChips } from '../../components/files/FileList.jsx';
import { Stagger, StaggerItem } from '../../components/motion/primitives.jsx';
import { thumbUrl } from '../../api/upload.js';

/** Read-only announcements — the CR authors these; students never modify. */
export default function StudentAnnouncementsPage() {
  const { user } = useAuth();
  const section = user?.section;
  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.announcements.list({ page: 1, limit: 30 }),
    [],
    () => studentApi.announcements.cachedList({ page: 1, limit: 30 })
  );
  // pinned first, then newest — pure ordering, content always server data
  const sorted = [...items].sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.createdAt) - new Date(a.createdAt));
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
        description={`Updates posted by your CR / GR for Section ${section.name}.`}
      />

      {error ? (
        <Alert variant="danger">
          <p className="font-medium">{error.message}</p>
          <div className="mt-2"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </Alert>
      ) : loading ? (
        <div className="space-y-3" role="status" aria-label="Loading announcements">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 skeleton-shimmer rounded-2xl border border-slate-200/60" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
          <div className="mb-3 flex justify-center text-slate-300"><IconMegaphone className="size-10" /></div>
          <h3 className="text-sm font-semibold text-slate-700">No announcements yet.</h3>
          <p className="mt-1 text-sm text-slate-500">When your CR or GR posts an update it will appear here.</p>
        </div>
      ) : (
        <Stagger className="space-y-3" role="list" aria-label="Announcements">
          {sorted.map((a) => {
            const image = (a.attachments ?? []).find(
              (f) => f?.resourceType === 'image' || ['png', 'jpg', 'jpeg', 'webp'].includes(f?.format)
            );
            return (
              <StaggerItem key={a._id} role="listitem">
                <button
                  type="button"
                  onClick={() => openDetail(a._id)}
                  className={`group block w-full rounded-2xl border p-4 text-left shadow-soft transition-all duration-200
                    hover:-translate-y-0.5 hover:shadow-lift active:scale-[0.99]
                    ${a.pinned
                      ? 'border-primary-200 bg-gradient-to-br from-primary-50/70 via-white to-white'
                      : 'border-slate-200/80 bg-white'}`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`grid size-10 shrink-0 place-items-center rounded-xl ring-1
                      ${a.pinned ? 'bg-primary-100 text-primary-700 ring-primary-200' : 'bg-primary-50 text-primary-600 ring-primary-100'}`}>
                      <IconMegaphone className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="min-w-0 text-sm font-semibold text-slate-900 transition-colors group-hover:text-primary-700">{a.title}</h3>
                        {a.pinned && <Badge variant="primary">Pinned</Badge>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-slate-500">{a.content}</p>
                      <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                        {a.author?.name ? `${a.author.name} · ` : ''}{timeAgo(a.createdAt)}
                        <FileChips files={a.attachments} />
                      </p>
                    </div>
                    {image?.url && (
                      <img
                        src={thumbUrl(image.url, 160)}
                        alt=""
                        loading="lazy"
                        className="size-16 shrink-0 rounded-xl object-cover ring-1 ring-slate-200"
                      />
                    )}
                  </div>
                </button>
              </StaggerItem>
            );
          })}
        </Stagger>
      )}

      <Modal open={openId != null} onClose={() => setOpenId(null)} title="Announcement">
        {detailLoading ? (
          <div className="space-y-3" role="status"><Skeleton className="h-5 w-2/3 rounded" /><SkeletonText lines={4} /></div>
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
                <div className="mt-2"><FileList files={detail.attachments} /></div>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
