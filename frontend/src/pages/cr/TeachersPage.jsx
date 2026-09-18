import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useDebounced, useFlash } from '../../admin/hooks.js';
import { DataTable } from '../../components/admin/DataTable.jsx';
import { PageHeader, FilterBar, SearchInput, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconPlus, IconPencil, IconTrash } from '../../components/icons.jsx';

/** Same normalization the backend applies — so the preview is always exact. */
function normalizeWhatsApp(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  let intl = digits;
  if (!hasPlus) {
    if (intl.startsWith('0')) intl = `92${intl.slice(1)}`;
    else if (intl.length <= 10) intl = `92${intl}`;
  }
  if (intl.length < 10 || intl.length > 15) return null;
  return intl;
}

/**
 * CR teachers — one teacher per subject. Linking a teacher to a subject is
 * what powers the WhatsApp deadline report: when an assignment's deadline
 * ends, that subject's teacher automatically receives a summary plus one
 * message per submitted student (name, roll number, file links).
 */
function TeacherForm({ open, onClose, initial, subjects, teachers, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [name, setName] = useState(initial?.name ?? '');
  const [subject, setSubject] = useState(initial?.subject?._id ?? '');
  const [whatsapp, setWhatsapp] = useState(initial?.whatsapp ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [designation, setDesignation] = useState(initial?.designation ?? '');
  const [errors, setErrors] = useState({});

  const intl = normalizeWhatsApp(whatsapp);
  const takenSubjects = new Set(
    (teachers ?? [])
      .filter((t) => t.subject?._id && (!isEdit || t.subject._id !== initial?.subject?._id))
      .map((t) => t.subject._id)
  );

  const submit = async () => {
    const next = {};
    if (name.trim().length < 2) next.name = 'Enter the teacher name.';
    if (!subject) next.subject = 'Pick the subject this teacher teaches.';
    if (!normalizeWhatsApp(whatsapp)) next.whatsapp = 'Enter a valid WhatsApp number (e.g. +92 301 2345678).';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = { name: name.trim(), subject, whatsapp: normalizeWhatsApp(whatsapp) };
    if (email.trim()) body.email = email.trim();
    if (designation.trim()) body.designation = designation.trim();

    if (isEdit) await crApi.teachers.update(initial._id, body);
    else await crApi.teachers.create(body);
    onSaved(isEdit ? 'Teacher updated.' : 'Teacher added.');
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit teacher' : 'New teacher'} submitLabel={isEdit ? 'Save changes' : 'Add teacher'} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          {!isEdit && subjects.length === 0 && (
            <Alert variant="warning">
              You need at least one active subject first — create it on the Subjects page, then link its teacher here.
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Teacher name" required id="cr-teacher-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dr. Ahmed Raza" error={errors.name ?? fieldErrors?.name ?? null} />
            <div>
              <Select
                label="Subject" required id="cr-teacher-subject"
                value={subject} onChange={(e) => setSubject(e.target.value)}
                error={errors.subject ?? fieldErrors?.subject ?? null}
              >
                <option value="">Select subject…</option>
                {subjects.map((s) => (
                  <option key={s._id} value={s._id} disabled={takenSubjects.has(s._id)}>
                    {s.name}{takenSubjects.has(s._id) ? ' — teacher added' : ''}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-500">Each subject can have exactly one teacher.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="WhatsApp number" required id="cr-teacher-whatsapp"
              value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)}
              placeholder="+92 301 2345678"
              hint={intl && !errors.whatsapp ? `Deadline reports will be sent to +${intl}` : 'Local numbers like 0301… are converted to +92 automatically.'}
              error={errors.whatsapp ?? fieldErrors?.whatsapp ?? null}
            />
            <Input label="Email (optional)" id="cr-teacher-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teacher@example.com" error={fieldErrors?.email ?? null} />
          </div>
          <Input label="Designation (optional)" id="cr-teacher-designation" value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder="Assistant Professor" hint="e.g. Lecturer, Professor" error={fieldErrors?.designation ?? null} />
        </>
      )}
    </FormModal>
  );
}

export default function TeachersPage() {
  const { user } = useAuth();
  const section = user?.section;

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [subjects, setSubjects] = useState([]);
  const [flash, showFlash] = useFlash();

  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => crApi.teachers.list({
      search: debouncedSearch || undefined,
      page, limit: 20,
    }),
    [debouncedSearch, page]
  );

  // Active subjects for the dropdown — teachers link to exactly one
  useEffect(() => {
    if (!section) return;
    let live = true;
    crApi.subjects.list({ status: 'active', limit: 100 })
      .then((res) => { if (live) setSubjects(res.data ?? []); })
      .catch(() => { if (live) setSubjects([]); });
    return () => { live = false; };
  }, [section, flash]);

  const [lastKey, setLastKey] = useState('');
  const key = debouncedSearch;
  if (key !== lastKey) { setLastKey(key); setPage(1); }

  if (!section) return <NoSection />;

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await crApi.teachers.delete(deleteTarget._id);
      setDeleteTarget(null);
      reload();
      showFlash('Teacher removed.');
    } catch (err) {
      setDeleteError(err);
    } finally {
      setDeleteBusy(false);
    }
  };

  const columns = [
    {
      key: 'name', header: 'Teacher',
      render: (t) => (
        <div>
          <span className="font-medium text-slate-900">{t.name}</span>
          {t.designation && <span className="block text-xs text-slate-500">{t.designation}</span>}
        </div>
      ),
    },
    {
      key: 'subject', header: 'Subject',
      render: (t) => (
        <div>
          <span className="font-medium text-slate-900">{t.subject?.name ?? '—'}</span>
          <span className="block font-mono text-xs text-slate-500">{t.subject?.code}</span>
        </div>
      ),
    },
    {
      key: 'whatsapp', header: 'WhatsApp',
      render: (t) => <span className="font-mono text-xs text-slate-700">+{t.whatsapp}</span>,
    },
    {
      key: 'email', header: 'Email', className: 'hidden lg:table-cell',
      render: (t) => t.email || '—',
    },
    {
      key: 'actions', header: '', headerClassName: 'text-right', className: 'text-right whitespace-nowrap',
      render: (t) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" icon={IconPencil} onClick={() => setModal({ mode: 'edit', teacher: t })}>Edit</Button>
          <Button variant="ghost" size="sm" icon={IconTrash} className="text-red-500 hover:text-red-700" onClick={() => { setDeleteTarget(t); setDeleteError(null); }}>Remove</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Teachers" description={`Faculty linked to ${section.name} subjects — assignment deadline reports are sent to their WhatsApp automatically.`}>
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New teacher</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, number, subject…" label="Search teachers" />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={items}
        loading={loading}
        error={error}
        onRetry={reload}
        pagination={pagination}
        onPageChange={setPage}
        emptyTitle="No teachers yet"
        emptyDescription="Link a teacher to each subject and they'll automatically receive a WhatsApp report when an assignment deadline ends — a summary plus every submission with roll numbers and files."
        emptyAction={<Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New teacher</Button>}
      />

      {modal && (
        <TeacherForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.teacher : null}
          subjects={subjects}
          teachers={items}
          onSaved={(msg) => { showFlash(msg); reload(); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Remove teacher?"
        body={
          <p>
            <span className="font-medium">{deleteTarget?.name}</span> will no longer receive WhatsApp deadline reports for <span className="font-medium">{deleteTarget?.subject?.name}</span>. This can be re-added anytime.
          </p>
        }
        confirmLabel="Remove teacher"
        onConfirm={confirmDelete}
        busy={deleteBusy}
        error={deleteError}
        danger
      />
    </div>
  );
}
