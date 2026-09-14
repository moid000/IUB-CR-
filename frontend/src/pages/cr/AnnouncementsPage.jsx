import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { formatDate, timeAgo } from '../../admin/format.js';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, SearchInput, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { Checkbox } from '../../components/ui/Checkbox.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconPlus, IconPencil, IconArchive, IconMegaphone } from '../../components/icons.jsx';

/**
 * CR announcements — always created in the CR's OWN section (server-derived).
 * The backend fans out in-app notifications to section members on create.
 */
function AnnouncementForm({ open, onClose, initial, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [errors, setErrors] = useState({});

  const submit = async () => {
    const next = {};
    if (title.trim().length < 2) next.title = 'Give the announcement a title.';
    if (!content.trim()) next.content = 'Announcement content is required.';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = { title: title.trim(), content: content.trim(), pinned };
    if (isEdit) await crApi.announcements.update(initial._id, body);
    else await crApi.announcements.create(body);
    onSaved(isEdit ? 'Announcement updated.' : 'Announcement published — your section has been notified.');
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
          <div>
            <label htmlFor="ann-content" className="mb-1.5 block text-sm font-medium text-slate-700">Content <span className="text-red-500" aria-hidden="true">*</span></label>
            <textarea
              id="ann-content" rows="6" value={content}
              onChange={(e) => setContent(e.target.value)}
              className={`block w-full rounded-lg border bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-300 focus:border-primary-500
                ${errors.content || fieldErrors?.content ? 'border-red-300' : 'border-slate-200'}`}
              placeholder="Write the announcement…"
            />
            {(errors.content || fieldErrors?.content) && (
              <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">{errors.content ?? fieldErrors.content}</p>
            )}
          </div>
          <Checkbox
            label="Pin this announcement"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
          />
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
          <Badge variant="gray">{item?.author?.name ?? 'CR'}</Badge>
          <span>{formatDate(item?.createdAt)}</span>
          <StatusBadge status={item?.status} />
          {item?.pinned && <Badge variant="primary">Pinned</Badge>}
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{item?.content}</p>
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
  const [viewTarget, setViewTarget] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => crApi.announcements.list({
      search: debouncedSearch || undefined,
      status: status !== 'all' ? status : undefined,
      page, limit: 10,
    }),
    [debouncedSearch, status, page]
  );

  const [lastKey, setLastKey] = useState('');
  const key = `${debouncedSearch}|${status}`;
  if (key !== lastKey) { setLastKey(key); setPage(1); }

  if (!section) return <NoSection />;

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
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-slate-100" />)}
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
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a._id} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft transition-shadow hover:shadow-lift">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setViewTarget(a)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">{a.title}</p>
                    {a.pinned && <Badge variant="primary">Pinned</Badge>}
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-500">{a.content}</p>
                  <p className="mt-2 text-xs text-slate-400">{a.author?.name ?? 'CR'} · {timeAgo(a.createdAt)}</p>
                </button>
                {a.status === 'published' && (
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="sm" icon={IconPencil} onClick={() => setModal({ mode: 'edit', item: a })}>Edit</Button>
                    <Button variant="ghost" size="sm" icon={IconArchive} className="text-slate-500 hover:text-red-600" onClick={() => { setArchiveTarget(a); setArchiveError(null); }}>Archive</Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
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
          onSaved={(msg) => { showFlash(msg); reload(); }}
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
    </div>
  );
}
