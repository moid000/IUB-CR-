import { Fragment, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import useFocusHighlight from '../../hooks/useFocusHighlight.js';
import useUnreadContent from '../../hooks/useUnreadContent.js';
import useAttachmentPrefetch, { warmAttachmentImages } from '../../hooks/useAttachmentPrefetch.js';
import { formatDate, timeAgo } from '../../admin/format.js';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, SearchInput, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Textarea } from '../../components/ui/Textarea.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { Checkbox } from '../../components/ui/Checkbox.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconPlus, IconPencil, IconArchive, IconTrash, IconMegaphone, IconPaperclip } from '../../components/icons.jsx';
import { FileList, FileChips } from '../../components/files/FileList.jsx';
import { AttachModal } from '../../components/files/AttachModal.jsx';
import { StagedFiles } from '../../components/files/StagedFiles.jsx';
import { createPostAndBroadcast } from '../../api/postFlow.js';
import { EarlierDivider, NewBadge, NewRail, NewUpdatesDivider } from '../../components/shared/NewContent.jsx';

/**
 * CR announcements — always created in the CR's OWN section (server-derived).
 * The backend fans out in-app notifications to section members on create.
 */
function AnnouncementForm({ open, onClose, initial, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [files, setFiles] = useState([]);
  const [errors, setErrors] = useState({});

  const submit = async () => {
    const next = {};
    if (title.trim().length < 2) next.title = 'Give the announcement a title.';
    if (!content.trim()) next.content = 'Announcement content is required.';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = { title: title.trim(), content: content.trim(), pinned };
    let created = null;
    if (isEdit) await crApi.announcements.update(initial._id, body);
    else ({
      doc: created,
    } = await createPostAndBroadcast({
      body,
      create: (b) => crApi.announcements.create(b),
      files,
      parentType: 'announcement',
      api: crApi.files,
      broadcast: (id) => crApi.announcements.broadcast(id),
    }));
    setFiles([]);
    onSaved(isEdit ? 'Announcement updated.' : 'Announcement published — your section has been notified.', created);
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit announcement' : 'New announcement'} submitLabel={isEdit ? 'Save changes' : 'Publish'} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          {!isEdit && (
            <p className="text-xs text-slate-500">Published to every active member of your section.</p>
          )}
          <Input
            label="Title" required id="ann-title" value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Quiz 1 syllabus" error={errors.title ?? fieldErrors?.title ?? null}
          />
          <Textarea id="ann-content" rows={6} label="Content" required value={content} onChange={(e) => setContent(e.target.value)} error={errors.content ?? fieldErrors?.content} placeholder="Write the announcement…" />
          <Checkbox
            label="Pin this announcement"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
          />
          {!isEdit && (
            <StagedFiles
              files={files}
              onAdd={(fs) => setFiles((prev) => [...prev, ...fs])}
              onRemove={(i) => setFiles((prev) => prev.filter((_, j) => j !== i))}
            />
          )}
        </>
      )}
    </FormModal>
  );
}

function ViewAnnouncementModal({ open, onClose, item }) {
  return (
    <Modal open={open} onClose={onClose} title={item?.title ?? 'Announcement'} className="max-w-lg">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <Badge variant="neutral">{item?.author?.name ?? 'CR'}</Badge>
          <span>{formatDate(item?.createdAt)}</span>
          <StatusBadge status={item?.status} />
          {item?.pinned && <Badge variant="primary">Pinned</Badge>}
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{item?.content}</p>
        {(item?.attachments?.length ?? 0) > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Attachments</p>
            <div className="mt-2"><FileList files={item.attachments} prefetchPreview /></div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function AnnouncementsPage() {
  const { user } = useAuth();
  const section = user?.section;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [status, setStatus] = useState('published');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null);
  const [attachItem, setAttachItem] = useState(null); // attachment manager target (separate state — no close race)
  const [viewTarget, setViewTarget] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => crApi.announcements.list({
      search: debouncedSearch || undefined,
      status: status !== 'all' ? status : undefined,
      page, limit: 10,
    }),
    [debouncedSearch, status, page],
    () => crApi.announcements.cachedList({
      search: debouncedSearch || undefined,
      status: status !== 'all' ? status : undefined,
      page, limit: 10,
    })
  );
  useAttachmentPrefetch(items);
  const unread = useUnreadContent(crApi.notifications, 'announcement', items);
  const displayItems = unread.ordered(items);
  const pageNewCount = displayItems.filter((a) => unread.isNew(a._id)).length;
  useFocusHighlight(displayItems);

  const [lastKey, setLastKey] = useState('');
  const key = `${debouncedSearch}|${status}`;
  if (key !== lastKey) { setLastKey(key); setPage(1); }

  if (!section) return <NoSection />;

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await crApi.announcements.delete(deleteTarget._id);
      setDeleteTarget(null);
      reload();
      showFlash('Announcement deleted permanently.');
    } catch (err) {
      setDeleteError(err);
    } finally {
      setDeleteBusy(false);
    }
  };

  const confirmArchive = async () => {
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      await crApi.announcements.archive(archiveTarget._id);
      setArchiveTarget(null);
      reload();
      showFlash('Announcement archived.');
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Announcements" description="News and updates for your section.">
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New announcement</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search announcements…" label="Search announcements" />
        <FilterSelect label="Status" value={status} onChange={setStatus}>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </FilterSelect>
      </FilterBar>

      {error ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft">
          <p className="text-sm font-medium text-red-600">{error.message}</p>
          <div className="mt-3"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </div>
      ) : loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 skeleton-shimmer rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft">
          <div className="flex flex-col items-center py-10 text-center">
            <IconMegaphone className="size-10 text-slate-300" />
            <h3 className="mt-3 text-sm font-semibold text-slate-700">No announcements yet.</h3>
            <p className="mt-1 max-w-sm text-sm text-slate-500">Publish the first update for your section — members get notified automatically.</p>
            <div className="mt-5"><Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New announcement</Button></div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {displayItems.map((a, index) => (
            <Fragment key={a._id}>
              {index === 0 && <NewUpdatesDivider count={pageNewCount} />}
              {index === pageNewCount && pageNewCount > 0 && pageNewCount < displayItems.length && <EarlierDivider />}
            <div data-item-id={a._id} className={`relative overflow-hidden rounded-2xl border p-5 shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lift [@media(hover:hover)]:active:scale-[0.99] ${unread.isNew(a._id) ? 'border-primary-200 bg-primary-50/60' : a.pinned ? 'border-primary-200 bg-gradient-to-br from-primary-50/70 via-white to-white' : 'border-slate-200/80 bg-white'}`}>
              {unread.isNew(a._id) && <NewRail />}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button
                  type="button"
                  onPointerDown={() => warmAttachmentImages(a.attachments)}
                  onClick={() => { unread.markSeen(a._id); setViewTarget(a); }}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex flex-wrap items-start gap-2">
                    <p dir="auto" className="min-w-0 flex-1 line-clamp-2 break-words font-semibold text-slate-900">{a.title}</p>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {unread.isNew(a._id) && <NewBadge />}
                      {a.pinned && <Badge variant="primary">Pinned</Badge>}
                      <StatusBadge status={a.status} />
                    </div>
                  </div>
                  <p dir="auto" className="mt-1 line-clamp-2 break-words text-sm text-slate-500">{a.content}</p>
                  <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
                    <p className="min-w-0 truncate text-xs text-slate-400">{a.author?.name ?? 'CR'} · {timeAgo(a.createdAt)}</p>
                    <FileChips files={a.attachments} />
                  </div>
                </button>
                {a.status === 'published' && (
                  <div className="grid w-full grid-cols-2 gap-1.5 sm:w-auto sm:flex sm:shrink-0 sm:flex-wrap sm:gap-1">
                    <Button variant="ghost" size="sm" className="w-full sm:w-auto" icon={IconPaperclip} onClick={() => setAttachItem(a)}>Files</Button>
                    <Button variant="ghost" size="sm" className="w-full sm:w-auto" icon={IconPencil} onClick={() => setModal({ mode: 'edit', item: a })}>Edit</Button>
                    <Button variant="ghost" size="sm" className="w-full text-slate-500 hover:text-red-600 sm:w-auto" icon={IconArchive} onClick={() => { setArchiveTarget(a); setArchiveError(null); }}>Archive</Button>
                    <Button variant="ghost" size="sm" className="w-full text-red-500 hover:text-red-700 sm:w-auto" icon={IconTrash} onClick={() => { setDeleteTarget(a); setDeleteError(null); }}>Delete</Button>
                  </div>
                )}
              </div>
            </div>
            </Fragment>
          ))}
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <span>Page {pagination.page} of {pagination.totalPages}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="secondary" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      {modal && (
        <AnnouncementForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.item : null}
          onSaved={(msg, created) => {
            showFlash(msg);
            reload();
            // polished flow: a brand-new announcement goes straight to attachments
            if (modal.mode === 'create' && created?._id) setAttachItem(created); // polished flow: straight to attachments
          }}
        />
      )}

      {attachItem && (
        <AttachModal
          open
          onClose={() => { setAttachItem(null); reload(); }}
          parentType="announcement"
          parentLabel="announcement"
          fetchItem={async () => (await crApi.announcements.get(attachItem._id))?.data}
          api={crApi.files}
          onDone={reload}
        />
      )}

      <ViewAnnouncementModal open={Boolean(viewTarget)} onClose={() => setViewTarget(null)} item={viewTarget} />

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Archive announcement?"
        body={<p><span className="font-medium">{archiveTarget?.title}</span> will be hidden from your section. This can't be undone from the app.</p>}
        confirmLabel="Archive announcement"
        onConfirm={confirmArchive}
        busy={archiveBusy}
        error={archiveError}
        danger
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete announcement?"
        body={<p><span className="font-medium">{deleteTarget?.title}</span> will be permanently deleted along with its attachments and related notifications. Students will no longer see it. This cannot be undone.</p>}
        confirmLabel="Delete announcement"
        onConfirm={confirmDelete}
        busy={deleteBusy}
        error={deleteError}
        danger
      />
    </div>
  );
}
