import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { PageHeader, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import NextClassCountdown from '../../components/shared/NextClassCountdown.jsx';
import { IconPlus, IconPencil, IconArchive, IconTrash, IconClock, IconCopy, IconChevronLeft, IconChevronRight } from '../../components/icons.jsx';

const TZ = 'Asia/Karachi';

function pktToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function prettyDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * CR timetable — DAILY wall-clock slots in Pakistan time. The CR picks a
 * date (default: today) and sets that day's classes. Times are sent
 * EXACTLY as HH:MM strings (never converted to UTC); the backend rejects
 * overlapping active slots on the same date (409). "Copy from another day"
 * duplicates a previous date's slots into the selected date in one call.
 */
function SlotForm({ open, onClose, initial, subjects, date, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [subject, setSubject] = useState(initial?.subject?._id ?? initial?.subject ?? '');
  const [startTime, setStartTime] = useState(initial?.startTime ?? '09:00');
  const [endTime, setEndTime] = useState(initial?.endTime ?? '10:30');
  const [room, setRoom] = useState(initial?.room ?? '');
  const [errors, setErrors] = useState({});

  const activeSubjects = useMemo(() => subjects.filter((s) => s.status === 'active'), [subjects]);

  const submit = async () => {
    const next = {};
    if (!subject) next.subject = 'Select a subject.';
    if (startTime >= endTime) next.endTime = 'End time must be after start time.';
    setErrors(next);
    if (Object.keys(next).length) throw new Error('Please fix the highlighted fields.');

    const body = { subject, date, startTime, endTime };
    if (room.trim()) body.room = room.trim();

    if (isEdit) await crApi.timetable.update(initial._id, body);
    else await crApi.timetable.create(body);
    onSaved(isEdit ? 'Class slot updated.' : 'Class slot added.');
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit class slot' : 'New class slot'} submitLabel={isEdit ? 'Save changes' : 'Add slot'} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          <Input label="Date" id="slot-date-info" value={`${prettyDate(date)} (PKT)`} readOnly hint="Selected date — change it on the page." />
          <Select label="Subject" required id="slot-subject" value={subject} onChange={(e) => setSubject(e.target.value)} error={errors.subject ?? fieldErrors?.subject ?? null}>
            <option value="">Select subject…</option>
            {activeSubjects.map((s) => <option key={s._id} value={s._id}>{s.code} — {s.name}</option>)}
            {activeSubjects.length === 0 && <option value="" disabled>No active subjects — create a subject first.</option>}
          </Select>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Starts" required id="slot-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} error={fieldErrors?.startTime ?? null} />
            <Input label="Ends" required id="slot-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} error={errors.endTime ?? fieldErrors?.endTime ?? null} />
          </div>
          <Input label="Room (optional)" id="slot-room" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Room 204, Block C" hint="Pakistan time (PKT) — stored exactly as entered." error={fieldErrors?.room ?? null} />
        </>
      )}
    </FormModal>
  );
}

function CopyForm({ open, onClose, toDate, onDone }) {
  const [fromDate, setFromDate] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await crApi.timetable.copy({ fromDate, toDate });
      onDone(res.data);
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormModal open={open} onClose={onClose} title={`Copy classes to ${prettyDate(toDate)}`} submitLabel="Copy classes" onSubmit={submit} size="md">
      {(fieldErrors) => (
        <>
          <p className="text-sm text-slate-500">Kisi pehle din ka poora schedule isi din copy kar lein. Jo slots is din pehle se hain, woh skip ho jayenge.</p>
          <Input label="Copy from date" required id="copy-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} error={fieldErrors?.fromDate ?? error?.message ?? null} />
        </>
      )}
    </FormModal>
  );
}

export default function TimetablePage() {
  const { user } = useAuth();
  const section = user?.section;

  const [date, setDate] = useState(pktToday);
  const [modal, setModal] = useState(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items: subjects } = useAdminQuery(() => crApi.subjects.list({ status: 'active', limit: 100 }), []);
  const { items, loading, error, reload } = useAdminQuery(
    () => crApi.timetable.list({ date, status: 'active', limit: 100 }), [date]
  );
  const { items: todaySlots, loading: todayLoading } = useAdminQuery(
    () => crApi.timetable.list({ date: pktToday(), status: 'active', limit: 100 }), []
  );

  if (!section) return <NoSection />;

  const today = pktToday();
  const isToday = date === today;

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await crApi.timetable.delete(deleteTarget._id);
      setDeleteTarget(null);
      reload();
      showFlash('Timetable slot deleted permanently.');
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
      await crApi.timetable.archive(archiveTarget._id);
      setArchiveTarget(null);
      reload();
      showFlash('Class slot removed from the timetable.');
    } catch (err) {
      setArchiveError(err);
    } finally {
      setArchiveBusy(false);
    }
  };

  const SlotCard = (t) => (
    <li key={t._id} className="group flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3.5 py-3">
      <IconClock className="size-4 shrink-0 text-primary-500" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-800">{t.subject?.name ?? '—'}</p>
        <p className="text-xs text-slate-500">{t.subject?.code}{t.room ? ` · Room ${t.room}` : ''}</p>
      </div>
      <span className="shrink-0 font-mono text-xs font-semibold text-slate-700">{t.startTime}–{t.endTime}</span>
      <div className="flex shrink-0 gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100">
        <Button variant="ghost" size="sm" icon={IconPencil} aria-label={`Edit ${t.subject?.name} slot`} onClick={() => setModal({ mode: 'edit', item: t })}>Edit</Button>
        <Button variant="ghost" size="sm" icon={IconArchive} aria-label={`Archive ${t.subject?.name} slot`} className="text-slate-500 hover:text-red-600" onClick={() => { setArchiveTarget(t); setArchiveError(null); }}>Archive</Button>
        <Button variant="ghost" size="sm" icon={IconTrash} className="text-red-500 hover:text-red-700" onClick={() => { setDeleteTarget(t); setDeleteError(null); }}>Delete</Button>
      </div>
    </li>
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Timetable" description={`Daily class schedule for ${section.name} — har din ka apna schedule set karein.`}>
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>Add class</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      {isToday && <div className="mb-4"><NextClassCountdown slots={todaySlots} loading={todayLoading} /></div>}

      {/* ---- Date navigation ---- */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200/80 bg-white p-3 shadow-soft">
        <Button variant="secondary" size="sm" icon={IconChevronLeft} aria-label="Previous day" onClick={() => setDate((d) => shiftDate(d, -1))}>Prev</Button>
        <Input id="tt-date" type="date" value={date} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} className="max-w-44" aria-label="Timetable date" />
        <Button variant="secondary" size="sm" icon={IconChevronRight} aria-label="Next day" onClick={() => setDate((d) => shiftDate(d, 1))}>Next</Button>
        {!isToday && <Button variant="secondary" size="sm" onClick={() => setDate(pktToday())}>Today</Button>}
        <span className="ml-auto flex items-center gap-2">
          {isToday && <Badge variant="primary">Today</Badge>}
          <span className="text-sm font-medium text-slate-600">{prettyDate(date)}</span>
          <Button variant="secondary" size="sm" icon={IconCopy} onClick={() => setCopyOpen(true)}>Copy from another day</Button>
        </span>
      </div>

      {error ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft">
          <p className="text-sm font-medium text-red-600">{error.message}</p>
          <div className="mt-3"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </div>
      ) : loading ? (
        <div className="h-44 skeleton-shimmer rounded-2xl" />
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft">
          <div className="flex flex-col items-center py-10 text-center">
            <IconClock className="size-10 text-slate-300" />
            <h3 className="mt-3 text-sm font-semibold text-slate-700">{prettyDate(date)} pe koi class set nahi.</h3>
            <p className="mt-1 max-w-sm text-sm text-slate-500">Is din ka schedule khud set karein, ya "Copy from another day" se pehle din ka schedule le aayen.</p>
            <div className="mt-5 flex gap-2">
              <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>Add class</Button>
              <Button variant="secondary" icon={IconCopy} onClick={() => setCopyOpen(true)}>Copy from another day</Button>
            </div>
          </div>
        </div>
      ) : (
        <section aria-label={`Classes on ${prettyDate(date)}`} className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-soft">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">{prettyDate(date)} — {items.length} {items.length === 1 ? 'class' : 'classes'}</h3>
          </div>
          <ul className="space-y-2">{items.map(SlotCard)}</ul>
        </section>
      )}

      <SlotForm
        open={Boolean(modal)}
        onClose={() => setModal(null)}
        initial={modal?.mode === 'edit' ? modal.item : null}
        subjects={subjects}
        date={date}
        onSaved={(msg) => { setModal(null); reload(); showFlash(msg); }}
      />

      <CopyForm
        open={copyOpen}
        onClose={() => setCopyOpen(false)}
        toDate={date}
        onDone={(res) => {
          setCopyOpen(false);
          reload();
          showFlash(res.copied > 0
            ? `${res.copied} class${res.copied === 1 ? '' : 'es'} copied${res.skipped.length ? ` — ${res.skipped.length} skipped (already booked time)` : ''}.`
            : `Nothing copied — all slots already exist on this date (${res.skipped.length} skipped).`);
        }}
      />

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Remove class slot?"
        body={<p><span className="font-medium">{archiveTarget?.subject?.name}</span> ({archiveTarget?.date}, {archiveTarget?.startTime}–{archiveTarget?.endTime}) will be removed from the timetable. Students will no longer see it.</p>}
        confirmLabel="Remove slot"
        onConfirm={confirmArchive}
        busy={archiveBusy}
        error={archiveError}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete class slot?"
        body={<p><span className="font-medium">{deleteTarget?.subject?.name}</span> ({deleteTarget?.date}, {deleteTarget?.startTime}–{deleteTarget?.endTime}) will be permanently deleted. This cannot be undone.</p>}
        confirmLabel="Delete slot"
        onConfirm={confirmDelete}
        busy={deleteBusy}
        error={deleteError}
        danger
      />
    </div>
  );
}
