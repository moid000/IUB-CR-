import { Fragment, useMemo, useRef, useState } from 'react';
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
import { IconFileText, IconBook, IconChevronRight } from '../../components/icons.jsx';
import { FileList, FileChips } from '../../components/files/FileList.jsx';
import useUnreadContent from '../../hooks/useUnreadContent.js';
import { EarlierDivider, NewBadge, NewRail, NewUpdatesDivider } from '../../components/shared/NewContent.jsx';
import useAttachmentPrefetch, { warmAttachmentImages } from '../../hooks/useAttachmentPrefetch.js';

/** Read-only notes — grouped into per-subject categories, newest-first inside
 *  each. Archived notes follow backend visibility. */
export default function StudentNotesPage() {
  const { user } = useAuth();
  const section = user?.section;
  const { items, loading, error, reload } = useAdminQuery(
    () => studentApi.notes.list({ page: 1, limit: 100 }),
    []
  );
  const [subjectFilter, setSubjectFilter] = useState('all');
  const [closedGroups, setClosedGroups] = useState(() => new Set());
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const detailRequest = useRef(0);
  const unread = useUnreadContent(studentApi.notifications, 'note', items);

  /** Subject categories built from the notes themselves (API returns them
   *  newest-first, so a subject appears in the order of its latest note). */
  const groups = useMemo(() => {
    const map = new Map();
    for (const n of items) {
      const k = n.subject?._id ?? n.subject ?? 'general';
      if (!map.has(k)) {
        map.set(k, { key: k, label: n.subject?.name ?? 'General', code: n.subject?.code ?? null, notes: [] });
      }
      map.get(k).notes.push(n);
    }
    const built = [...map.values()].map((g) => {
      const notes = unread.ordered(g.notes);
      return { ...g, notes, newCount: notes.filter((n) => unread.isNew(n._id)).length };
    });
    // Subject groups containing unseen notes come first; original newest-subject
    // order remains stable within the NEW and Earlier sections.
    return built.sort((a, b) => Number(b.newCount > 0) - Number(a.newCount > 0));
  }, [items, unread.isNew, unread.ordered]);

  const visibleGroups = useMemo(
    () => (subjectFilter === 'all' ? groups : groups.filter((g) => g.key === subjectFilter)),
    [groups, subjectFilter]
  );
  useAttachmentPrefetch(items);

  const toggleGroup = (k) =>
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  if (!section) return <NoSection />;

  const openDetail = (item) => {
    const request = ++detailRequest.current;
    setOpenId(item._id);
    setDetail(item);
    warmAttachmentImages(item.attachments);
    studentApi.notes.get(item._id)
      .then((res) => { if (detailRequest.current === request && res?.data) setDetail(res.data); })
      .catch(() => {});
  };
  const closeDetail = () => {
    detailRequest.current += 1;
    setOpenId(null);
  };

  useFocusHighlight(visibleGroups);
  const chipClass = (active) =>
    `inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
      active
        ? 'bg-primary-600 text-white shadow-soft'
        : 'border border-slate-200/80 bg-white text-slate-600 shadow-soft hover:bg-slate-50'
    }`;

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
          <div className="h-8 skeleton-shimmer rounded-full" />
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
        <>
          {/* Subject category chips */}
          <div
            className="relative -mx-1 [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-28px),transparent)]"
          >
          <div
            className="flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="tablist"
            aria-label="Filter notes by subject"
          >
            <button
              type="button"
              role="tab"
              aria-selected={subjectFilter === 'all'}
              onClick={() => setSubjectFilter('all')}
              className={chipClass(subjectFilter === 'all')}
            >
              All subjects
              <span className={`rounded-full px-1.5 text-[10px] font-semibold ${subjectFilter === 'all' ? 'bg-white/25' : 'bg-slate-100 text-slate-500'}`}>
                {items.length}
              </span>
            </button>
            {groups.map((g) => (
              <button
                key={g.key}
                type="button"
                role="tab"
                aria-selected={subjectFilter === g.key}
                onClick={() => setSubjectFilter(subjectFilter === g.key ? 'all' : g.key)}
                className={chipClass(subjectFilter === g.key)}
              >
                {g.label}
                <span className={`rounded-full px-1.5 text-[10px] font-semibold ${subjectFilter === g.key ? 'bg-white/25' : 'bg-slate-100 text-slate-500'}`}>
                  {g.notes.length}
                </span>
              </button>
            ))}
          </div>
          </div>

          {/* Subject-wise groups, newest-first inside each */}
          <div className="space-y-5">
            {visibleGroups.map((g) => {
              const open = !closedGroups.has(g.key);
              return (
                <section key={g.key} aria-label={`${g.label} notes`}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={open}
                    className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-white px-3.5 py-2.5 text-left shadow-soft transition-colors hover:bg-slate-50"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-600">
                        <IconBook className="size-3.5" />
                      </span>
                      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">
                        {g.code ? <>{g.code}<span className="mx-1.5 font-normal text-slate-300">·</span></> : null}{g.label}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {g.newCount > 0 && <NewBadge />}
                      <Badge variant="neutral">{g.notes.length}</Badge>
                      <IconChevronRight className={`size-4 text-slate-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
                    </span>
                  </button>
                  {open && (
                    <ul className="mt-2.5 space-y-3">
                      {g.notes.map((n, index) => (
                        <Fragment key={n._id}>
                          {index === 0 && <li className="list-none"><NewUpdatesDivider count={g.newCount} /></li>}
                          {index === g.newCount && g.newCount > 0 && g.newCount < g.notes.length && <li className="list-none"><EarlierDivider /></li>}
                        <li>
                          <button
                            type="button"
                            data-item-id={n._id}
                            onPointerDown={() => warmAttachmentImages(n.attachments)}
                            onClick={() => { unread.markSeen(n._id); openDetail(n); }}
                            className={`relative w-full overflow-hidden rounded-2xl border p-5 text-left shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lift [@media(hover:hover)]:active:scale-[0.99] ${
                              unread.isNew(n._id) ? 'border-primary-200 bg-primary-50/60' : 'border-slate-200/80 bg-white'
                            }`}
                          >
                            {unread.isNew(n._id) && <NewRail />}
                            <div className="flex items-start justify-between gap-2">
                              <h3 dir="auto" className="min-w-0 line-clamp-2 text-sm font-semibold text-slate-900">{n.title}</h3>
                              {unread.isNew(n._id) && <NewBadge />}
                            </div>
                            {n.content && <p dir="auto" className="mt-1.5 line-clamp-2 text-sm text-slate-600">{n.content}</p>}
                            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
                              <p className="text-xs text-slate-400">{timeAgo(n.createdAt)}</p>
                              <FileChips files={n.attachments} />
                            </div>
                          </button>
                        </li>
                        </Fragment>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      <Modal open={openId != null} onClose={closeDetail} title="Note">
        {detail ? (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h3 dir="auto" className="text-base font-semibold text-slate-900">{detail.title}</h3>
              {detail.subject && <Badge variant="primary">{detail.subject.name}</Badge>}
            </div>
            {detail.content && (
              <p dir="auto" className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{detail.content}</p>
            )}
            <p className="text-xs text-slate-400">Shared {formatDate(detail.createdAt)}</p>
            {(detail.attachments?.length ?? 0) > 0 && (
              <div className="border-t border-slate-100 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Attachments</p>
                <div className="mt-2"><FileList files={detail.attachments} prefetchPreview /></div>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
