import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { formatDate } from '../../admin/format.js';
import { Badge } from '../../components/ui/Badge.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Modal } from '../../components/ui/Modal.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Spinner } from '../../components/ui/Spinner.jsx';
import { PageHeader, FilterBar, FilterSelect, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconPlus, IconPencil, IconCheckCircle, IconArchive, IconInfo } from '../../components/icons.jsx';

const ASSESSMENT_TYPES = ['quiz', 'assignment', 'midterm', 'final', 'practical', 'viva', 'project', 'other'];
const STATUS_STYLES = {
  draft: { label: 'Draft', variant: 'neutral' },
  open: { label: 'Open', variant: 'primary' },
  finalized: { label: 'Finalized', variant: 'success' },
  archived: { label: 'Archived', variant: 'neutral' },
};

function AssessmentStatus({ status }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.draft;
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/**
 * CR marks & assessments. Lifecycle is strictly draft → open → finalized →
 * archived (no reopen). Marks can be entered/edited ONLY while open;
 * finalized assessments are read-only. Missing marks stay missing — they
 * are NEVER auto-converted to zero.
 */
function AssessmentForm({ open, onClose, initial, subjects, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [type, setType] = useState(initial?.type ?? 'quiz');
  const [subject, setSubject] = useState(initial?.subject?._id ?? initial?.subject ?? '');
  const [totalMarks, setTotalMarks] = useState(initial?.totalMarks != null ? String(initial.totalMarks) : '');
  const [assessmentDate, setAssessmentDate] = useState(
    initial?.assessmentDate ? String(initial.assessmentDate).slice(0, 10) : new Date().toISOString().slice(0, 10)
  );
  const [weightage, setWeightage] = useState(initial?.weightage != null ? String(initial.weightage) : '');
  const [errors, setErrors] = useState({});

  const activeSubjects = useMemo(() => subjects.filter((s) => s.status === 'active'), [subjects]);

  const submit = async () => {
    const next = {};
    if (title.trim().length < 2) next.title = 'Give the assessment a title.';
    if (!subject) next.subject = 'Select a subject.';
    const tm = Number(totalMarks);
    if (!Number.isInteger(tm) || tm < 1 || tm > 1000) next.totalMarks = 'Total marks must be a whole number (1–1000).';
    if (!assessmentDate) next.assessmentDate = 'Pick the assessment date.';
    if (weightage !== '' && (Number.isNaN(Number(weightage)) || Number(weightage) < 0 || Number(weightage) > 100)) {
      next.weightage = 'Weightage must be between 0 and 100.';
    }
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = {
      title: title.trim(),
      type,
      subject,
      totalMarks: tm,
      assessmentDate: new Date(`${assessmentDate}T00:00:00`).toISOString(),
    };
    if (weightage !== '') body.weightage = Number(weightage);

    if (isEdit) await crApi.assessments.update(initial._id, body);
    else await crApi.assessments.create(body);
    onSaved(isEdit ? 'Assessment updated.' : 'Assessment created as draft. Open it when you\'re ready to enter marks.');
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit assessment' : 'New assessment'} submitLabel={isEdit ? 'Save changes' : 'Create assessment'} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          <Input label="Title" required id="asmt-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Quiz 1" error={errors.title ?? fieldErrors?.title ?? null} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select label="Type" required id="asmt-type" value={type} onChange={(e) => setType(e.target.value)} error={fieldErrors?.type ?? null}>
              {ASSESSMENT_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
            </Select>
            <Select label="Subject" required id="asmt-subject" value={subject} onChange={(e) => setSubject(e.target.value)} error={errors.subject ?? fieldErrors?.subject ?? null}>
              <option value="">Select subject…</option>
              {activeSubjects.map((s) => <option key={s._id} value={s._id}>{s.code} — {s.name}</option>)}
              {activeSubjects.length === 0 && <option value="" disabled>No active subjects — create a subject first.</option>}
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Input label="Total marks" required id="asmt-total" type="number" min="1" step="1" value={totalMarks} onChange={(e) => setTotalMarks(e.target.value)} error={errors.totalMarks ?? fieldErrors?.totalMarks ?? null} />
            <Input label="Date" required id="asmt-date" type="date" value={assessmentDate} onChange={(e) => setAssessmentDate(e.target.value)} error={errors.assessmentDate ?? fieldErrors?.assessmentDate ?? null} />
            <Input label="Weightage (optional)" id="asmt-weightage" type="number" min="0" max="100" step="0.01" value={weightage} onChange={(e) => setWeightage(e.target.value)} hint="0–100" error={errors.weightage ?? fieldErrors?.weightage ?? null} />
          </div>
          {isEdit && (
            <Alert variant="info">Total marks can't go below marks already entered. Assessments that are finalized or archived are read-only.</Alert>
          )}
        </>
      )}
    </FormModal>
  );
}

/** Marks entry — per-student inputs, saved via the bulk upsert endpoint. */
function MarksModal({ open, onClose, assessment, onFinalized }) {
  const [data, setData] = useState(null); // { assessment, items, missing, counts }
  const [error, setError] = useState(null);
  const [values, setValues] = useState({}); // studentId → string
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState(null);

  const finalized = data?.assessment?.status === 'finalized' || data?.assessment?.status === 'archived';
  const total = data?.assessment?.totalMarks ?? null;

  const load = () => {
    crApi.assessments.marks.list(assessment._id)
      .then((res) => {
        const d = res?.data ?? null;
        setData(d);
        const init = {};
        d?.items?.forEach((m) => { init[m.student?._id ?? m.student] = String(m.marksObtained); });
        setValues(init);
      })
      .catch(setError);
  };

  useEffect(() => {
    if (!open) return undefined;
    setData(null);
    setError(null);
    setSaveError(null);
    setFinalizeError(null);
    load();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, assessment?._id]);

  const enteredBy = new Set((data?.items ?? []).map((m) => String(m.student?._id ?? m.student)));
  const rows = (data?.items ?? []).map((m) => ({ student: m.student, mark: m }))
    .concat((data?.missing ?? []).map((s) => ({ student: s, mark: null })))
    .map((r) => ({ ...r, entered: enteredBy.has(String(r.student?._id ?? r.student)) }));

  const changedRows = Object.entries(values).filter(([id, v]) => {
    const existing = (data?.items ?? []).find((m) => String(m.student?._id ?? m.student) === id);
    return existing ? String(existing.marksObtained) !== v : v !== '';
  });

  const save = async () => {
    if (changedRows.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await crApi.assessments.marks.bulk(
        assessment._id,
        changedRows.map(([student, v]) => ({ student, marksObtained: Number(v) }))
      );
      load();
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const finalize = async () => {
    setFinalizing(true);
    setFinalizeError(null);
    try {
      await crApi.assessments.finalize(assessment._id);
      onFinalized();
      onClose();
    } catch (err) {
      setFinalizeError(err);
    } finally {
      setFinalizing(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Marks — ${data?.assessment?.title ?? assessment?.title ?? ''}`}
      className="max-w-lg"
      footer={
        <>
          {!finalized && changedRows.length > 0 && (
            <Button variant="secondary" onClick={save} loading={saving}>Save {changedRows.length} mark{changedRows.length === 1 ? '' : 's'}</Button>
          )}
          {!finalized && (
            <Button variant="danger" onClick={() => setConfirmFinalize(true)}>Finalize</Button>
          )}
        </>
      }
    >
      {error ? (
        <Alert variant="danger">{error.message}</Alert>
      ) : !data ? (
        <div className="grid place-items-center py-8" role="status" aria-label="Loading marks"><Spinner className="size-6 text-primary-500" /></div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <AssessmentStatus status={data.assessment.status} />
            <span className="text-slate-500">{data.assessment.subject?.name} · total {data.assessment.totalMarks}</span>
            <span className="ml-auto text-xs text-slate-500">
              {data.counts.entered} entered · {data.counts.missing} missing
            </span>
          </div>

          {saveError && <Alert variant="danger">{saveError.message}</Alert>}
          {finalizeError && <Alert variant="danger">{finalizeError.message}</Alert>}
          {finalized && (
            <Alert variant="info">This assessment is finalized — marks are locked and read-only.</Alert>
          )}

          {rows.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
              No active students in your section — marks can't be entered.
            </p>
          ) : (
            <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
              {rows.map((r) => {
                const id = r.student?._id ?? r.student;
                return (
                  <div key={id} className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3.5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">{r.student?.name ?? '—'}</p>
                      <p className="text-xs text-slate-500">{r.student?.rollNo}</p>
                    </div>
                    {r.mark && !finalized ? (
                      <Badge variant="success">Entered</Badge>
                    ) : r.mark ? (
                      <Badge variant="primary">Finalized</Badge>
                    ) : (
                      <Badge variant="warning">Missing</Badge>
                    )}
                    <input
                      type="number" inputMode="numeric" min="0" max={total ?? undefined} step="1"
                      aria-label={`Marks for ${r.student?.name ?? 'student'}`}
                      disabled={finalized}
                      value={values[id] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [id]: e.target.value }))}
                      className="w-20 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 disabled:bg-slate-100 disabled:text-slate-500"
                      placeholder="—"
                    />
                  </div>
                );
              })}
            </div>
          )}
          {!finalized && changedRows.length > 0 && (
            <p className="text-xs text-slate-500">{changedRows.length} unsaved change{changedRows.length === 1 ? '' : 's'} — save before finalizing. Missing marks stay missing (never auto-zero).</p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmFinalize}
        onClose={() => setConfirmFinalize(false)}
        title="Finalize assessment?"
        body={(
          <p>
            Marks for <span className="font-medium">{data?.assessment?.title ?? 'this assessment'}</span> will be locked permanently.
            {data?.counts?.missing > 0 && <span className="text-amber-600"> {data.counts.missing} student{data.counts.missing === 1 ? '' : 's'} still missing marks — they'll stay missing.</span>}
          </p>
        )}
        confirmLabel="Finalize marks"
        onConfirm={async () => {
          setConfirmFinalize(false);
          await finalize();
        }}
        busy={finalizing}
        error={finalizeError}
        danger
      />
    </Modal>
  );
}

export default function MarksPage() {
  const { user } = useAuth();
  const section = user?.section;

  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null); // { mode:'create'|'edit', item? }
  const [marksFor, setMarksFor] = useState(null);
  const [openTarget, setOpenTarget] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [openBusy, setOpenBusy] = useState(false);
  const [openError, setOpenError] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items: subjects } = useAdminQuery(() => crApi.subjects.list({ status: 'active', limit: 100 }), []);
  const { items, pagination, loading, error, reload } = useAdminQuery(
    () => crApi.assessments.list({
      status: statusFilter !== 'all' ? statusFilter : undefined,
      page, limit: 10,
    }),
    [statusFilter, page]
  );

  if (!section) return <NoSection />;

  const confirmOpen = async () => {
    setOpenBusy(true);
    setOpenError(null);
    try {
      await crApi.assessments.open(openTarget._id);
      setOpenTarget(null);
      reload();
      showFlash('Assessment is open — marks can now be entered.');
    } catch (err) {
      setOpenError(err);
    } finally {
      setOpenBusy(false);
    }
  };

  const confirmArchive = async () => {
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      await crApi.assessments.archive(archiveTarget._id);
      setArchiveTarget(null);
      reload();
      showFlash('Assessment archived.');
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiveBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Marks & Assessments" description="Quizzes, assignments and exams for your section.">
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New assessment</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      <FilterBar>
        <FilterSelect label="Status" value={statusFilter} onChange={setStatusFilter}>
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="open">Open</option>
          <option value="finalized">Finalized</option>
          <option value="archived">Archived</option>
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
            <IconCheckCircle className="size-10 text-slate-300" />
            <h3 className="mt-3 text-sm font-semibold text-slate-700">No assessments created yet.</h3>
            <p className="mt-1 max-w-sm text-sm text-slate-500">Create one, open it during class, enter marks, then finalize to lock them.</p>
            <div className="mt-5"><Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>New assessment</Button></div>
          </div>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a._id} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-soft transition-shadow hover:shadow-lift">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">{a.title}</p>
                    <AssessmentStatus status={a.status} />
                    <Badge variant="gray">{a.type}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-500">
                    {a.subject?.name ?? '—'} · {a.totalMarks} marks · {formatDate(a.assessmentDate)}
                    {a.weightage != null ? ` · ${a.weightage}% weight` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setMarksFor(a)}>
                    {a.status === 'draft' ? 'Preview' : a.status === 'open' ? 'Enter marks' : 'View marks'}
                  </Button>
                  {a.status === 'draft' && (
                    <>
                      <Button variant="ghost" size="sm" icon={IconPencil} onClick={() => setModal({ mode: 'edit', item: a })}>Edit</Button>
                      <Button variant="ghost" size="sm" onClick={() => { setOpenTarget(a); setOpenError(null); }}>Open</Button>
                    </>
                  )}
                  {a.status === 'open' && (
                    <Button variant="ghost" size="sm" onClick={() => setMarksFor(a)}>Enter marks</Button>
                  )}
                  {a.status !== 'archived' && (
                    <Button variant="ghost" size="sm" icon={IconArchive} className="text-slate-500 hover:text-red-600" onClick={() => { setArchiveTarget(a); setArchiveError(null); }}>Archive</Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>Page {pagination.page} of {pagination.totalPages}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="secondary" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      <div className="flex items-start gap-3 rounded-xl border border-slate-100 bg-white/70 p-4 text-sm text-slate-500">
        <IconInfo className="mt-0.5 size-4 shrink-0 text-slate-400" />
        <p>
          Lifecycle: <span className="font-medium text-slate-600">Draft → Open → Finalized → Archived</span>.
          Marks are editable only while open. Finalizing locks marks permanently; missing marks stay missing — never auto-zero.
        </p>
      </div>

      {modal && (
        <AssessmentForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.item : null}
          subjects={subjects}
          onSaved={(msg) => { showFlash(msg); reload(); }}
        />
      )}

      {marksFor && (
        <MarksModal open onClose={() => setMarksFor(null)} assessment={marksFor} onFinalized={() => { showFlash('Assessment finalized — marks are locked.'); reload(); }} />
      )}

      <ConfirmDialog
        open={Boolean(openTarget)}
        onClose={() => setOpenTarget(null)}
        title="Open assessment?"
        body={<p>Students will see <span className="font-medium">{openTarget?.title}</span> and you can start entering marks immediately.</p>}
        confirmLabel="Open assessment"
        onConfirm={confirmOpen}
        busy={openBusy}
        error={openError}
      />

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Archive assessment?"
        body={<p><span className="font-medium">{archiveTarget?.title}</span> will be hidden from your section. Its marks are preserved.</p>}
        confirmLabel="Archive assessment"
        onConfirm={confirmArchive}
        busy={archiveBusy}
        error={archiveError}
        danger
      />
    </div>
  );
}
