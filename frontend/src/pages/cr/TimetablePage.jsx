import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useAdminQuery, useFlash } from '../../admin/hooks.js';
import { PageHeader, ConfirmDialog, FormModal, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Input } from '../../components/ui/Input.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconPlus, IconPencil, IconArchive, IconClock } from '../../components/icons.jsx';

const DAYS = [
  { value: 'monday', label: 'Monday' },
  { value: 'tuesday', label: 'Tuesday' },
  { value: 'wednesday', label: 'Wednesday' },
  { value: 'thursday', label: 'Thursday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
];

const TZ = 'Asia/Karachi';

function todayKey() {
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: TZ })
    .format(new Date()).toLowerCase();
  return DAYS.some((d) => d.value === day) ? day : null;
}

/**
 * CR timetable — weekly wall-clock slots in Pakistan time. Times are sent
 * EXACTLY as HH:MM strings (never converted to UTC); the backend rejects
 * overlapping active slots on the same day (409).
 */
function SlotForm({ open, onClose, initial, subjects, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [subject, setSubject] = useState(initial?.subject?._id ?? initial?.subject ?? '');
  const [day, setDay] = useState(initial?.day ?? 'monday');
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

    const body = { subject, day, startTime, endTime };
    if (room.trim()) body.room = room.trim();

    if (isEdit) await crApi.timetable.update(initial._id, body);
    else await crApi.timetable.create(body);
    onSaved(isEdit ? 'Timetable slot updated.' : 'Timetable slot added.');
  };

  return (
    <FormModal open={open} onClose={onClose} title={isEdit ? 'Edit class slot' : 'New class slot'} submitLabel={isEdit ? 'Save changes' : 'Add slot'} onSubmit={submit} size="lg">
      {(fieldErrors) => (
        <>
          <Select label="Subject" required id="slot-subject" value={subject} onChange={(e) => setSubject(e.target.value)} error={errors.subject ?? fieldErrors?.subject ?? null}>
            <option value="">Select subject…</option>
            {activeSubjects.map((s) => <option key={s._id} value={s._id}>{s.code} — {s.name}</option>)}
            {activeSubjects.length === 0 && <option value="" disabled>No active subjects — create a subject first.</option>}
          </Select>
          <Select label="Day" required id="slot-day" value={day} onChange={(e) => setDay(e.target.value)}>
            {DAYS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </Select>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Starts" required id="slot-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} error={fieldErrors?.startTime ?? null} />
            <Input label="Ends" required id="slot-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} error={errors.endTime ?? fieldErrors?.endTime ?? null} />
          </div>
          <Input label="Room (optional)" id="slot-room" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="Room 204, Block C" hint="Pakistan time (PKT) — stored exactly as entered." error={fieldErrors?.room ?? null} />
          {fieldErrors?.day && <p role="alert" className="text-xs font-medium text-red-600">{fieldErrors.day}</p>}
        </>
      )}
    </FormModal>
  );
}

export default function TimetablePage() {
  const { user } = useAuth();
  const section = user?.section;

  const [modal, setModal] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState(null);
  const [flash, showFlash] = useFlash();

  const { items: subjects } = useAdminQuery(() => crApi.subjects.list({ status: 'active', limit: 100 }), []);
  const { items, loading, error, reload } = useAdminQuery(
    () => crApi.timetable.list({ status: 'active', limit: 100 }), []
  );

  const today = todayKey();

  // Group by day — the backend already orders monday→saturday, start→end
  const byDay = useMemo(() => {
    const map = Object.fromEntries(DAYS.map((d) => [d.value, []]));
    items.forEach((t) => { if (map[t.day]) map[t.day].push(t); });
    return map;
  }, [items]);

  if (!section) return <NoSection />;

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
      </div>
    </li>
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Timetable" description={`Weekly class schedule for ${section.name}.`}>
        <Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>Add class</Button>
      </PageHeader>

      <SuccessFlash message={flash} />

      {error ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft">
          <p className="text-sm font-medium text-red-600">{error.message}</p>
          <div className="mt-3"><Button variant="secondary" size="sm" onClick={reload}>Try again</Button></div>
        </div>
      ) : loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {DAYS.map((d) => <div key={d.value} className="h-44 animate-pulse rounded-2xl bg-slate-100" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft">
          <div className="flex flex-col items-center py-10 text-center">
            <IconClock className="size-10 text-slate-300" />
            <h3 className="mt-3 text-sm font-semibold text-slate-700">No timetable entries yet.</h3>
            <p className="mt-1 max-w-sm text-sm text-slate-500">Add your section's weekly classes — times are in Pakistan time and overlaps are prevented automatically.</p>
            <div className="mt-5"><Button icon={IconPlus} onClick={() => setModal({ mode: 'create' })}>Add class</Button></div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {DAYS.map((d) => (
            <section key={d.value} aria-label={d.label} className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-soft">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">{d.label}</h3>
                {today === d.value && <Badge variant="primary">Today</Badge>}
              </div>
              {byDay[d.value].length === 0 ? (
                <p className="rounded-xl bg-slate-50 px-3 py-4 text-center text-xs text-slate-400">No classes</p>
              ) : (
                <ul className="space-y-2">{byDay[d.value].map(SlotCard)}</ul>
              )}
            </section>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-start gap-3 rounded-xl border border-slate-100 bg-white/70 p-4 text-sm text-slate-500">
        <IconClock className="mt-0.5 size-4 shrink-0 text-slate-400" />
        <p>Class times are wall-clock <span className="font-medium text-slate-600">Pakistan time (PKT)</span>. Sundays aren't a valid class day; two classes can't overlap on the same day.</p>
      </div>

      {modal && (
        <SlotForm
          open
          onClose={() => setModal(null)}
          initial={modal.mode === 'edit' ? modal.item : null}
          subjects={subjects}
          onSaved={(msg) => { showFlash(msg); reload(); }}
        />
      )}

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Remove class slot?"
        body={<p><span className="font-medium">{archiveTarget?.subject?.name}</span> ({archiveTarget?.day}, {archiveTarget?.startTime}–{archiveTarget?.endTime}) will be removed from the weekly timetable.</p>}
        confirmLabel="Remove slot"
        onConfirm={confirmArchive}
        busy={archiveBusy}
        error={archiveError}
        danger
      />
    </div>
  );
}
