import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { timeAgo } from '../../admin/format.js';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, SearchInput, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconPlus, IconPencil, IconArchive, IconTrash, IconFileText, IconPaperclip } from '../../components/icons.jsx';
import { FileList, FileChips } from '../../components/files/FileList.jsx';
import { AttachModal } from '../../components/files/AttachModal.jsx';

/**
 * CR notes — section-scoped, optionally linked to an ACTIVE subject of the
 * SAME section (validated server-side; archived subjects are rejected).
 */
function NoteForm({ open, onClose, initial, subjects, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [subject, setSubject] = useState(initial?.subject?._id ?? initial?.subject ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [errors, setErrors] = useState({});

  const activeSubjects = useMemo(() => subjects.filter((s) => s.status === 'active'), [subjects]);

  const submit = async () => {
    const next = {};
    if (title.trim().length < 2) next.title = 'Give the note a title.';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = { title: title.trim() };
    if (content.trim()) body.content = content.trim();
    if (subject) body.subject = subject;

    let created = null;
    if (isEdit) await crApi.notes.update(initial._id, body);
    else created = (await crApi.notes.create(body))?.data;
    onSaved(isEdit ? 'Note updated.' : 'Note created.', created);
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit note' : 'New note'} submitLabel={isEdit ? 'Save changes' : 'Create note'} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          <Input label="Title" required id="note-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chapter 4 — lecture summary" error={errors.title ?? fieldErrors?.title ?? null} />
          <Select label="Subject (optional)" id="note-subject" value={subject} onChange={(e) => setSubject(e.target.value)} error={fieldErrors?.subject ?? null}>
            <option value="">No subject</option>
            {activeSubjects.map((s) => <option key={s._id} value={s._id}>{s.code} — {s.name}</option>)}
            {activeSubjects.length === 0 && <option value="" disabled>No active subjects — create a subject first.</option>}
          </Select>
          <div>
            <label htmlFor="note-content" className="mb-1.5 block text-sm font-medium text-slate-700">Content (optional)</label>
            <textarea
              id="note-content" rows="6" value={content}
              onChange={(e) => setContent(e.target.value)}
              className="block w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-300 focus:border-primary-500"
              placeholder="Write the note… files can be attached after saving."
            />
            {fieldErrors?.content && <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">{fieldErrors.content}</p>}
          </div>
        </>
      )}
    </FormModal>
  );
}

function ViewNoteModal({ open, onClose, item }) {
  const subjectName = item?.subject?.name ?? item?.subjectName ?? null;
  return (
    <Modal open={open} onClose={onClose} title={item?.title ?? 'Note'} className="max-w-lg">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {subjectName && <Badge variant="gray">{subjectName}</Badge>}
          <StatusBadge status={item?.status} />
          <span>{timeAgo(item?.createdAt)}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{item?.content || 'No written content.'}</p>
        {(item?.attachments?.length ?? 0) > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Attachments</p>
            <div className="mt-2"><FileList files={item.attachments} /></div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function NotesPage() {
  const { user } = useAuth();
  const section = user?.section;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [subjectFilter, setSubjectFilter] = useState('all');
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

  const { items: subjects } = useAdminQuery(() => crApi.subjects.list({ status: 'active', limit: 100 }), []);

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => crApi.notes.list({
      search: debouncedSearch || undefined,
      subjectId: subjectFilter !== 'all' ? subjectFilter : undefined,
      status: status !== 'all' ? status : undefined,
      page, limit: 10,
    }),
    [debouncedSearch, subjectFilter, status, page]
  );

  const [lastKey, setLastKey] = useState('');
  const key = `${debouncedSearch}|${subjectFilter}|${status}`;
  if (key !== lastKey) { setLastKey(key); setPage(1); }

  if (!section) return <NoSection />;

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await crApi.notes.delete(deleteTarget._id);
      setDeleteTarget(null);
      reload();
      showFlash('Note deleted permanently.');
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
      await crApi.notes.archive(archiveTarget._id);
      setArchiveTarget(null);
      reload();
      showFlash('Note archived.');
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Notes" description="Study material and shared knowledge for your section.">
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New note</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search notes…" label="Search notes" />
        <FilterSelect label="Subject" value={subjectFilter} onChange={setSubjectFilter}>
          <option value="all">All subjects</option>
          {subjects.map((s) => <option key={s._id} value={s._id}>{s.code}</option>)}
        </FilterSelect>
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
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-slate-100" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconFileText className="size-10" />}
          title="No notes yet."
          description="Share lecture summaries, formulas or reading lists with your section."
          action={<Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New note</Button>}
        />
      ) : (
        <ul className="space-y-3">
          {items.map((n) => (
            <li key={n._id} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft transition-shadow hover:shadow-lift">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button type="button" onClick={() => setViewTarget(n)} className="min-w-0 flex-1 text-left">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">{n.title}</p>
                    {n.subject?.name && <Badge variant="gray">{n.subject.name}</Badge>}
                    <StatusBadge status={n.status} />
                  </div>
                  {n.content && <p className="mt-1 line-clamp-2 text-sm text-slate-500">{n.content}</p>}
                  <p className="mt-2 flex items-center gap-2 text-xs text-slate-400">
                    {timeAgo(n.createdAt)} <FileChips files={n.attachments} />
                  </p>
                </button>
                {n.status === 'published' && (
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="sm" icon={IconPaperclip} onClick={() => setAttachItem(n)}>Files</Button>
                    <Button variant="ghost" size="sm" icon={IconPencil} onClick={() => setModal({ mode: 'edit', item: n })}>Edit</Button>
                    <Button variant="ghost" size="sm" icon={IconArchive} className="text-slate-500 hover:text-red-600" onClick={() => { setArchiveTarget(n); setArchiveError(null); }}>Archive</Button>
                    <Button variant="ghost" size="sm" icon={IconTrash} className="text-red-500 hover:text-red-700" onClick={() => { setDeleteTarget(n); setDeleteError(null); }}>Delete</Button>
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
        <NoteForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.item : null}
          subjects={subjects}
          onSaved={(msg, created) => {
            showFlash(msg);
            reload();
            if (modal.mode === 'create' && created?._id) setAttachItem(created); // polished flow: straight to attachments
          }}
        />
      )}

      {attachItem && (
        <AttachModal
          open
          onClose={() => { setAttachItem(null); reload(); }}
          parentType="note"
          parentLabel="note"
          fetchItem={async () => (await crApi.notes.get(attachItem._id))?.data}
          api={crApi.files}
          onDone={reload}
        />
      )}

      <ViewNoteModal open={Boolean(viewTarget)} onClose={() => setViewTarget(null)} item={viewTarget} />

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Archive note?"
        body={<p><span className="font-medium">{archiveTarget?.title}</span> will be hidden from your section. This can't be undone from the app.</p>}
        confirmLabel="Archive note"
        onConfirm={confirmArchive}
        busy={archiveBusy}
        error={archiveError}
        danger
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete note?"
        body={<p><span className="font-medium">{deleteTarget?.title}</span> will be permanently deleted along with its attached files. Students will no longer see it. This cannot be undone.</p>}
        confirmLabel="Delete note"
        onConfirm={confirmDelete}
        busy={deleteBusy}
        error={deleteError}
        danger
      />
    </div>
  );
}
