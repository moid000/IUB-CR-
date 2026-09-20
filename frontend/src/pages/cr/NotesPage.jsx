import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { timeAgo } from '../../admin/format.js';
import { StatusBadge } from '../../components/admin/StatusBadge.jsx';
import { PageHeader, FilterBar, FilterSelect, SearchInput, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Textarea } from '../../components/ui/Textarea.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconPlus, IconPencil, IconArchive, IconTrash, IconFileText, IconPaperclip, IconBook, IconChevronRight } from '../../components/icons.jsx';
import { FileList, FileChips } from '../../components/files/FileList.jsx';
import { AttachModal } from '../../components/files/AttachModal.jsx';
import { StagedFiles } from '../../components/files/StagedFiles.jsx';
import { createPostAndBroadcast } from '../../api/postFlow.js';

/** CR notes — section-scoped, linked to an ACTIVE subject of the SAME section
 *  (validated server-side; archived subjects are rejected). */
function NoteForm({ open, onClose, initial, subjects, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [subject, setSubject] = useState(initial?.subject?._id ?? initial?.subject ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [errors, setErrors] = useState({});
  const [files, setFiles] = useState([]);

  const activeSubjects = useMemo(() => subjects.filter((s) => s.status === 'active'), [subjects]);
  // Categorised notes: a note MUST land in a subject category whenever the
  // section has subjects — that's what keeps the student side organized.
  const subjectRequired = activeSubjects.length > 0;

  const submit = async () => {
    const next = {};
    if (title.trim().length < 2) next.title = 'Give the note a title.';
    if (subjectRequired && !subject) next.subject = 'Pick the subject this note belongs to.';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = { title: title.trim() };
    if (content.trim()) body.content = content.trim();
    if (subject) body.subject = subject;

    let created = null;
    if (isEdit) await crApi.notes.update(initial._id, body);
    else ({
      doc: created,
    } = await createPostAndBroadcast({
      create: (b) => crApi.notes.create(b),
      files,
      parentType: 'note',
      api: crApi.files,
      broadcast: (id) => crApi.notes.broadcast(id),
    }));
    setFiles([]);
    onSaved(isEdit ? 'Note updated.' : 'Note created.', created);
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit note' : 'New note'} submitLabel={isEdit ? 'Save changes' : 'Create note'} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          <Select
            label={subjectRequired ? 'Subject' : 'Subject (optional)'}
            required={subjectRequired}
            id="note-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            error={errors.subject ?? fieldErrors?.subject ?? null}
          >
            {!subjectRequired && <option value="">No subject</option>}
            {activeSubjects.map((s) => <option key={s._id} value={s._id}>{s.code} — {s.name}</option>)}
            {activeSubjects.length === 0 && <option value="" disabled>No active subjects — create a subject first.</option>}
          </Select>
          <Input label="Title" required id="note-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chapter 4 — lecture summary" error={errors.title ?? fieldErrors?.title ?? null} />
          <Textarea id="note-content" rows={6} label="Content (optional)" value={content} onChange={(e) => setContent(e.target.value)} error={fieldErrors?.content} placeholder="Write the note…" />
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

function ViewNoteModal({ open, onClose, item }) {
  const subjectName = item?.subject?.name ?? item?.subjectName ?? null;
  return (
    <Modal open={open} onClose={onClose} title={item?.title ?? 'Note'} className="max-w-lg">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {subjectName && <Badge variant="neutral">{subjectName}</Badge>}
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
  const [closedGroups, setClosedGroups] = useState(() => new Set());

  const { items: subjects } = useAdminQuery(() => crApi.subjects.list({ status: 'active', limit: 100 }), []);

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => crApi.notes.list({
      search: debouncedSearch || undefined,
      subjectId: subjectFilter !== 'all' ? subjectFilter : undefined,
      status: status !== 'all' ? status : undefined,
      page, limit: 24,
    }),
    [debouncedSearch, subjectFilter, status, page]
  );

  const [lastKey, setLastKey] = useState('');
  const key = `${debouncedSearch}|${subjectFilter}|${status}`;
  if (key !== lastKey) { setLastKey(key); setPage(1); }

  /** Notes grouped into per-subject categories, newest-first inside each.
   *  Group order follows the subject list; un-categorised notes fall into a
   *  trailing "General" category (legacy notes only — new ones require a
   *  subject whenever the section has any). */
  const groups = useMemo(() => {
    const order = new Map(subjects.map((s, i) => [s._id, i]));
    const keyOf = (n) => (n.subject?._id ?? n.subject ?? 'general');
    const map = new Map();
    for (const n of items) {
      const k = keyOf(n);
      if (!map.has(k)) {
        map.set(k, { key: k, label: n.subject?.name ?? 'General', code: n.subject?.code ?? null, notes: [] });
      }
      map.get(k).notes.push(n);
    }
    return [...map.values()].sort((a, b) => {
      const rank = (g) => (g.key === 'general' ? 999 : order.get(g.key) ?? 998);
      return rank(a) - rank(b);
    });
  }, [items, subjects]);

  const toggleGroup = (k) =>
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

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

  const renderCard = (n) => (
    <li key={n._id} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft transition-shadow hover:shadow-lift">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button type="button" onClick={() => setViewTarget(n)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-slate-900">{n.title}</p>
            <StatusBadge status={n.status} />
          </div>
          {n.content && <p className="mt-1 line-clamp-2 text-sm text-slate-500">{n.content}</p>}
          <p className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            {timeAgo(n.createdAt)} <FileChips files={n.attachments} />
          </p>
        </button>
        {n.status === 'published' && (
          <div className="grid w-full grid-cols-2 gap-1.5 sm:w-auto sm:flex sm:shrink-0 sm:flex-wrap sm:gap-1">
            <Button variant="ghost" size="sm" className="w-full sm:w-auto" icon={IconPaperclip} onClick={() => setAttachItem(n)}>Files</Button>
            <Button variant="ghost" size="sm" className="w-full sm:w-auto" icon={IconPencil} onClick={() => setModal({ mode: 'edit', item: n })}>Edit</Button>
            <Button variant="ghost" size="sm" className="w-full text-slate-500 hover:text-red-600 sm:w-auto" icon={IconArchive} onClick={() => { setArchiveTarget(n); setArchiveError(null); }}>Archive</Button>
            <Button variant="ghost" size="sm" className="w-full text-red-500 hover:text-red-700 sm:w-auto" icon={IconTrash} onClick={() => { setDeleteTarget(n); setDeleteError(null); }}>Delete</Button>
          </div>
        )}
      </div>
    </li>
  );

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Notes" description="Organized by subject — study material for your section.">
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
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 skeleton-shimmer rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconFileText className="size-10" />}
          title="No notes yet."
          description="Share lecture summaries, formulas or reading lists with your section."
          action={<Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New note</Button>}
        />
      ) : (
        <div className="space-y-5">
          {groups.map((g) => {
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
                    <Badge variant="neutral">{g.notes.length}</Badge>
                    <IconChevronRight className={`size-4 text-slate-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
                  </span>
                </button>
                {open && <ul className="mt-2.5 space-y-3">{g.notes.map(renderCard)}</ul>}
              </section>
            );
          })}
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
