import { Fragment, useRef, useState } from 'react';
import useFocusHighlight from '../../hooks/useFocusHighlight.js';
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
import { thumbUrl } from '../../api/upload.js';
import useUnreadContent from '../../hooks/useUnreadContent.js';
import { EarlierDivider, NewBadge, NewRail, NewUpdatesDivider } from '../../components/shared/NewContent.jsx';
import useAttachmentPrefetch, { warmAttachmentImages } from '../../hooks/useAttachmentPrefetch.js';

/** Read-only announcements — the CR authors these; students never modify. */
export default function StudentAnnouncementsPage() {
  const { user } = useAuth();
  const section = user?.section;
  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.announcements.list({ page: 1, limit: 30 }),
    [],
    () => studentApi.announcements.cachedList({ page: 1, limit: 30 })
  );
  const unread = useUnreadContent(studentApi.notifications, 'announcement', items);
  // NEW first, then pinned, then newest. Stable `ordered` preserves the old
  // order inside each seen/unseen section.
  const sorted = unread.ordered([...items].sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.createdAt) - new Date(a.createdAt)));
  const pageNewCount = sorted.filter((a) => unread.isNew(a._id)).length;
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const detailRequest = useRef(0);
  useAttachmentPrefetch(items);

  if (!section) return <NoSection />;

  const openDetail = (item) => {
    const request = ++detailRequest.current;
    // The list response already contains the complete readable document.
    // Paint it in this click's render; refresh silently in the background.
    setOpenId(item._id);
    setDetail(item);
    warmAttachmentImages(item.attachments);
    studentApi.announcements.get(item._id)
      .then((res) => { if (detailRequest.current === request && res?.data) setDetail(res.data); })
      .catch(() => {}); // stale list data remains fully usable offline/on weak data
  };
  const closeDetail = () => {
    detailRequest.current += 1;
    setOpenId(null);
  };

  useFocusHighlight(sorted);
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
        <div className="space-y-3" role="list" aria-label="Announcements">
          {sorted.map((a, index) => {
            const image = (a.attachments ?? []).find(
              (f) => f?.resourceType === 'image' || ['png', 'jpg', 'jpeg', 'webp'].includes(f?.format)
            );
            return (
              <Fragment key={a._id}>
                {index === 0 && <NewUpdatesDivider count={pageNewCount} />}
                {index === pageNewCount && pageNewCount > 0 && pageNewCount < sorted.length && <EarlierDivider />}
              <div role="listitem">
                <button
                  type="button"
                  data-item-id={a._id}
                  onPointerDown={() => warmAttachmentImages(a.attachments)}
                  onClick={() => { unread.markSeen(a._id); openDetail(a); }}
                  className={`group relative block w-full overflow-hidden rounded-2xl border p-4 text-left shadow-soft transition-all duration-200
                    hover:-translate-y-0.5 hover:shadow-lift [@media(hover:hover)]:active:scale-[0.99]
                    ${unread.isNew(a._id)
                      ? 'border-primary-200 bg-primary-50/60'
                      : a.pinned
                        ? 'border-primary-200 bg-gradient-to-br from-primary-50/70 via-white to-white'
                        : 'border-slate-200/80 bg-white'}`}
                >
                  {unread.isNew(a._id) && <NewRail />}
                  {/* Title/content row — a large title is clamped to 2 lines (owner
                      2026-09-22: a long title used to grow the card to 6+ lines, wildly
                      inconsistent next to short ones; full title is still shown once the
                      card is opened). The meta row (author/time/attachment pill) lives in
                      its OWN full-width row below, never sharing space with the thumbnail —
                      that's what was crushing the timestamp to "14…" before. */}
                  <div className="flex items-start gap-3">
                    <span className={`grid size-10 shrink-0 place-items-center rounded-xl ring-1
                      ${a.pinned ? 'bg-primary-100 text-primary-700 ring-primary-200' : 'bg-primary-50 text-primary-600 ring-primary-100'}`}>
                      <IconMegaphone className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="min-w-0 line-clamp-2 text-sm font-semibold text-slate-900 transition-colors group-hover:text-primary-700">{a.title}</h3>
                        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                          {unread.isNew(a._id) && <NewBadge />}
                          {a.pinned && <Badge variant="primary">Pinned</Badge>}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-slate-500">{a.content}</p>
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
                  <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
                    <p className="min-w-0 truncate text-xs text-slate-500">
                      {a.author?.name ? `${a.author.name} · ` : ''}{timeAgo(a.createdAt)}
                    </p>
                    <FileChips files={a.attachments} />
                  </div>
                </button>
              </div>
              </Fragment>
            );
          })}
        </div>
      )}

      <Modal open={openId != null} onClose={closeDetail} title="Announcement">
        {detail ? (
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
