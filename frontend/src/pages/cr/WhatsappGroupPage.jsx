import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { crApi } from '../../api/cr.js';
import { useFlash } from '../../admin/hooks.js';
import { PageHeader, ConfirmDialog, SuccessFlash } from '../../components/admin/controls.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Alert } from '../../components/ui/Alert.jsx';
import { Card } from '../../components/ui/Card.jsx';
import { NoSection } from '../../cr/NoSection.jsx';
import { IconChatBubble, IconCheck, IconArrowPath, IconInfo } from '../../components/icons.jsx';

/**
 * WhatsApp class-group broadcasts.
 *
 * The section's CR/GR links ONE class WhatsApp group here. The paired Tri3M
 * number must already be a member of that group — the page lists every group
 * the number can see, the CR picks theirs. From then on, announcements,
 * assignments, notes and timetable changes are automatically posted to the
 * group. Marks are never broadcast.
 */

function StepCard({ n, title, children }) {
  return (
    <div className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary-600 text-xs font-semibold text-white">{n}</span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-800">{title}</p>
        <div className="mt-0.5 text-sm text-slate-500">{children}</div>
      </div>
    </div>
  );
}

/**
 * Human explanation for an empty group list — the privacy filter means
 * "empty" has three very different causes.
 */
function explainEmpty(d) {
  if (d.reason === 'no-phone') {
    return 'Your profile has no WhatsApp number — ask the admin to add it to your profile, then refresh again.';
  }
  if ((d.totalGroups ?? 0) > 0) {
    return `The Tri3M number is in ${d.totalGroups} group${d.totalGroups === 1 ? '' : 's'}, but none of them contains your WhatsApp number ${d.matchedPhone ?? ''}. Only groups where YOU are a member are shown — join your class group with this same number, then refresh.`;
  }
  return 'No groups found. Make sure the Tri3M number was added to your class WhatsApp group first.';
}

export default function WhatsappGroupPage() {
  const { user } = useAuth();
  const section = user?.section;
  const { flash, show } = useFlash();

  const [cfg, setCfg] = useState(null); // { group, instanceNumber, appUrl }
  const [groups, setGroups] = useState(null); // null = not fetched yet
  const [meta, setMeta] = useState(null); // { totalGroups, matchedPhone, reason }
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const linked = cfg?.group ?? null;

  useEffect(() => {
    let alive = true;
    crApi.whatsappGroup.config()
      .then((res) => { if (alive) setCfg(res.data); })
      .catch((err) => { if (alive) setError(err.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const refresh = async () => {
    setRefreshing(true); setError('');
    try {
      const res = await crApi.whatsappGroup.refreshGroups();
      setGroups(res.data.groups);
      setMeta({
        totalGroups: res.data.totalGroups ?? 0,
        matchedPhone: res.data.matchedPhone ?? null,
        reason: res.data.reason ?? null,
      });
      if (!res.data.groups.length) setError(explainEmpty(res.data));
    } catch (err) {
      setError(err.message);
      setGroups([]);
    } finally {
      setRefreshing(false);
    }
  };

  const save = async () => {
    const group = (groups ?? []).find((g) => g.id === selected);
    if (!group) return;
    setSaving(true); setError('');
    try {
      const res = await crApi.whatsappGroup.link({ groupId: group.id, groupName: group.name });
      setCfg((c) => ({ ...c, group: res.data.group }));
      setSelected('');
      show('WhatsApp group linked — section posts will now reach the group.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const unlink = async () => {
    setConfirmUnlink(false);
    setError('');
    try {
      await crApi.whatsappGroup.unlink();
      setCfg((c) => ({ ...c, group: null }));
      setGroups(null);
      show('WhatsApp group unlinked. Section posts will no longer be sent.');
    } catch (err) {
      setError(err.message);
    }
  };

  if (!section) return <NoSection />;

  return (
    <>
      <PageHeader
        title="WhatsApp Group"
        description={`Link your class WhatsApp group — ${section.name} posts (announcements, assignments, notes, timetable) are delivered to it automatically.`}
      />

      <SuccessFlash message={flash} />

      {error && !loading && <Alert className="mb-4" variant="danger">{error}</Alert>}

      {loading ? (
        <Card className="animate-pulse p-6"><div className="h-20 rounded-lg bg-slate-100" /></Card>
      ) : linked ? (
        /* ------------------------- LINKED STATE ------------------------- */
        <Card className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3.5">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
                <IconChatBubble className="size-5.5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-base font-semibold text-slate-900">{linked.name}</p>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-100">
                    <IconCheck className="size-3" /> Linked
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  Everything you post in {section.name} goes to this group automatically.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" icon={IconArrowPath} onClick={refresh} disabled={refreshing}>
                {refreshing ? 'Refreshing…' : 'Change group'}
              </Button>
              <Button variant="danger" onClick={() => setConfirmUnlink(true)}>Unlink</Button>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <IconInfo className="size-3.5" /> What gets sent
            </p>
            <div className="mt-2.5 grid gap-1.5 text-sm text-slate-600 sm:grid-cols-2">
              <p>📢 Announcements</p>
              <p>📋 Assignments (with due date)</p>
              <p>📄 Notes</p>
              <p>📅 Timetable changes &amp; cancellations</p>
            </div>
            <p className="mt-2.5 text-xs text-slate-400">Marks are never sent to the group.</p>
          </div>

          {(groups ?? null) !== null && (
            <div className="mt-5">
              <p className="mb-2 text-sm font-medium text-slate-700">Pick a different group</p>
              <GroupPicker groups={groups} selected={selected} onSelect={setSelected} emptyNote={error} />
              <div className="mt-3 flex justify-end">
                <Button onClick={save} disabled={!selected || saving}>
                  {saving ? 'Saving…' : 'Save group'}
                </Button>
              </div>
            </div>
          )}
        </Card>
      ) : (
        /* ------------------------ UNLINKED STATE ------------------------ */
        <Card className="p-6">
          <div className="flex items-start gap-3.5">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary-50 text-primary-600 ring-1 ring-primary-100">
              <IconChatBubble className="size-5.5" />
            </span>
            <div className="min-w-0">
              <p className="text-base font-semibold text-slate-900">Connect your class group</p>
              <p className="mt-1 text-sm text-slate-500">
                Your section's posts will appear in WhatsApp automatically — no manual forwarding.
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-4 border-t border-slate-100 pt-5">
            <StepCard n={1} title="Add the Tri3M number to your class WhatsApp group">
              Add <span className="font-semibold text-slate-700">{cfg?.instanceNumber ?? 'the Tri3M WhatsApp number'}</span> as a
              member, exactly like any other member. Only a group admin can do this.
            </StepCard>
            <StepCard n={2} title="Refresh below">
              Only groups that contain your own WhatsApp number are listed — other sections' groups stay hidden.
            </StepCard>
            <StepCard n={3} title="Select your section's group and save">
              Announcements, assignments, notes and timetable changes will then reach the group automatically.
            </StepCard>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
            <Button icon={IconArrowPath} onClick={refresh} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : 'Refresh groups'}
            </Button>
            {groups === null && <p className="text-sm text-slate-400">You haven't fetched the group list yet.</p>}
          </div>

          {groups !== null && (
            <div className="mt-5">
              <GroupPicker groups={groups} selected={selected} onSelect={setSelected} emptyNote={error} />
              <div className="mt-3 flex justify-end">
                <Button onClick={save} disabled={!selected || saving}>
                  {saving ? 'Saving…' : 'Link group'}
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={confirmUnlink}
        onClose={() => setConfirmUnlink(false)}
        title="Unlink WhatsApp group?"
        body={
          <p>
            Section posts will stop appearing in <span className="font-semibold">{linked?.name}</span>.
            You can link it again anytime.
          </p>
        }
        confirmLabel="Unlink"
        onConfirm={unlink}
      />
    </>
  );
}

function GroupPicker({ groups, selected, onSelect, emptyNote }) {
  if (!groups.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 p-5 text-center">
        <p className="text-sm font-medium text-slate-600">No matching groups</p>
        <p className="mt-1 text-sm text-slate-400">
          {emptyNote || 'Add the Tri3M number to your class WhatsApp group first, then refresh.'}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {groups.map((g) => {
        const active = g.id === selected;
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => onSelect(g.id)}
            className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
              active ? 'border-primary-600 bg-primary-50/60 ring-1 ring-primary-100' : 'border-slate-200 bg-white hover:bg-slate-50'
            }`}
          >
            <span
              className={`grid size-5 shrink-0 place-items-center rounded-full border-2 ${
                active ? 'border-primary-600 bg-primary-600' : 'border-slate-300'
              }`}
            >
              {active && <IconCheck className="size-3 text-white" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-slate-800">{g.name}</span>
              <span className="block truncate text-xs text-slate-400">{g.id}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
