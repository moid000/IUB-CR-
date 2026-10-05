import { Section, Subject } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import { sendText, sendImage, sendDocument, sendAudio, sendVideo, listGroups, isConfigured } from './whatsappService.js';
import { normalizeWhatsApp } from './teacherService.js';
import { env } from '../config/env.js';
import * as v from '../utils/validators.js';

/**
 * WhatsApp group broadcasts — each section links ONE GENERAL class WhatsApp
 * group (the paired Tri3M number must be a member of it), and each SUBJECT
 * may additionally link its own group (owner request 2026-10-03):
 *   - announcements + timetable changes  → the section's GENERAL group
 *   - assignments + notes               → the POST'S SUBJECT's group,
 *     falling back to the general group when the subject has no group
 *     (or a note carries no subject) — a post is never silently dropped.
 *
 * Scope (owner-confirmed 2026-09-20): announcements, assignments, notes and
 * timetable changes are broadcast. MARKS ARE NEVER BROADCAST — excluded per
 * owner's explicit instruction.
 *
 * Every broadcast is best-effort: it loads the linked group(s) and sends via
 * the existing UltraMsg gateway. Failures are logged and swallowed — a group
 * message can never break the user's create/update flow.
 */

const APP_URL = process.env.APP_URL || 'https://www.tri2m.com' // custom domain live 2026-10-05 (was iubcr.vercel.app);
const GROUP_ID_RE = /^[\w.-]+@g\.us$/;
const PKT = 'Asia/Karachi';

const PKT_DEADLINE_FMT = new Intl.DateTimeFormat('en-PK', {
  timeZone: PKT,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const PKT_DATE_FMT = new Intl.DateTimeFormat('en-PK', {
  timeZone: PKT,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/** "13:00" (PKT wall-clock) → "1:00 PM". */
function fmt12(time) {
  const [h, m] = String(time).split(':').map(Number);
  if (!Number.isFinite(h)) return String(time);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 || 12;
  return `${hh}:${String(m ?? 0).padStart(2, '0')} ${ampm}`;
}

/** "2026-09-26" (PKT wall-clock date) → "Sat 26 Sept". */
function fmtWallDate(date) {
  const d = new Date(`${date}T12:00:00+05:00`); // PKT noon — timezone-safe for date-only strings
  return PKT_DATE_FMT.format(d);
}

/* ------------------------- CR group configuration ------------------------ */

async function ownSection(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const section = await Section.findById(req.user.section);
  if (!section) throw new ApiError(400, 'Section not found');
  return section;
}

export async function getGroupConfigCr(req) {
  const section = await ownSection(req);
  const g = section.whatsappGroup;
  // Subject groups: the section's own subjects with their linked groups, so
  // the CR can see and manage routing (assignments/notes go to these).
  const subjects = await Subject.find({ section: section._id, status: 'active' })
    .select('name code whatsappGroup').sort({ name: 1 }).lean();
  return {
    group: g && g.id ? { id: g.id, name: g.name, linkedAt: g.linkedAt } : null,
    subjects: subjects.map((sub) => {
      const sg = sub.whatsappGroup;
      return {
        id: sub._id, name: sub.name, code: sub.code,
        group: sg && sg.id ? { id: sg.id, name: sg.name, linkedAt: sg.linkedAt } : null,
      };
    }),
    gatewayPhone: prettyNumber(env.whatsapp.gatewayPhone) || env.whatsapp.gatewayPhone || null,
    appUrl: APP_URL,
  };
}

/**
 * "923019670950" → "+92 301 9670950" (for UI display only).
 */
function prettyNumber(intl) {
  if (!intl) return null;
  if (intl.startsWith('92') && intl.length >= 12) return `+92 ${intl.slice(2, 5)} ${intl.slice(5)}`;
  return `+${intl}`;
}

/**
 * Groups the CR is personally a member of (their registered WhatsApp number
 * appears in the participant list). Owner-confirmed privacy rule 2026-09-20:
 * the Tri3M number may be a member of MANY sections' groups — a CR must only
 * ever see (and link) groups that contain THEIR OWN number, so other
 * sections' group names never leak to them.
 */
function myGroups(all, user) {
  const crPhone = normalizeWhatsApp(user?.phone ?? '');
  if (!crPhone) return { phone: null, groups: [] };
  const mine = all.filter((g) => (g.participants ?? []).includes(crPhone));
  return { phone: crPhone, groups: mine };
}

/** Fresh group list straight from the gateway — the CR's "Refresh" button. */
export async function refreshGroupsCr(req) {
  await ownSection(req); // a sectionless CR/GR can never configure broadcasts
  const all = await listGroups();
  const { phone, groups: mine } = myGroups(all, req.user);
  if (!phone) {
    // CR has no usable WhatsApp number on their profile — nothing can match.
    return { groups: [], totalGroups: all.length, reason: 'no-phone' };
  }
  return {
    groups: mine.map(({ id, name }) => ({ id, name })),
    totalGroups: all.length,
    matchedPhone: prettyNumber(phone),
  };
}

/* Membership gate shared by the general and subject link flows: the CR can
 * only link a group that contains their OWN registered WhatsApp number — the
 * client cannot inject another section's group id/name. */
async function assertLinkableGroup(req, rawGroupId) {
  const id = v.assertText(rawGroupId, 'groupId').trim();
  if (!GROUP_ID_RE.test(id)) throw new ApiError(400, 'Invalid WhatsApp group id');
  const all = await listGroups();
  const { phone, groups: mine } = myGroups(all, req.user);
  if (!phone) {
    throw new ApiError(400, 'Your profile has no WhatsApp number — ask the admin to add it first');
  }
  const group = mine.find((g) => g.id === id);
  if (!group) {
    throw new ApiError(400, 'You can only link a group that contains your own WhatsApp number');
  }
  return { id, name: String(group.name || 'Group').trim().slice(0, 100) };
}

export async function linkGroupCr(req) {
  const section = await ownSection(req);
  const body = v.pick(req.body, ['groupId', 'groupName']);
  const { id, name } = await assertLinkableGroup(req, body.groupId);

  section.whatsappGroup = { id, name, linkedBy: req.user._id, linkedAt: new Date() };
  await section.save();
  await auditFromReq(req, {
    action: 'whatsappGroup.link', entityType: 'section', entityId: section._id,
    after: { groupId: id, groupName: name },
  });
  return { group: { id, name, linkedAt: section.whatsappGroup.linkedAt } };
}

export async function unlinkGroupCr(req) {
  const section = await ownSection(req);
  const before = section.whatsappGroup?.name ?? null;
  section.whatsappGroup = null;
  await section.save();
  await auditFromReq(req, {
    action: 'whatsappGroup.unlink', entityType: 'section', entityId: section._id,
    before: { groupName: before }, after: { groupName: null },
  });
  return { group: null };
}

/* --------------------- subject group configuration ---------------------- */

/** Link a subject's OWN WhatsApp group (assignments/notes routing). */
export async function linkSubjectGroupCr(req) {
  const section = await ownSection(req);
  const subject = await Subject.findOne({
    _id: v.assertObjectId(req.params.subjectId, 'subjectId'),
    section: section._id, status: 'active',
  });
  if (!subject) throw new ApiError(404, 'Subject not found');
  const body = v.pick(req.body, ['groupId', 'groupName']);
  const { id, name } = await assertLinkableGroup(req, body.groupId);

  subject.whatsappGroup = { id, name, linkedBy: req.user._id, linkedAt: new Date() };
  await subject.save();
  await auditFromReq(req, {
    action: 'whatsappSubjectGroup.link', entityType: 'subject', entityId: subject._id,
    section: section._id,
    after: { subject: subject.name, groupId: id, groupName: name },
  });
  return { subjectId: subject._id, subject: subject.name, group: { id, name, linkedAt: subject.whatsappGroup.linkedAt } };
}

export async function unlinkSubjectGroupCr(req) {
  const section = await ownSection(req);
  const subject = await Subject.findOne({
    _id: v.assertObjectId(req.params.subjectId, 'subjectId'),
    section: section._id, status: 'active',
  });
  if (!subject) throw new ApiError(404, 'Subject not found');
  const before = subject.whatsappGroup?.name ?? null;
  subject.whatsappGroup = null;
  await subject.save();
  await auditFromReq(req, {
    action: 'whatsappSubjectGroup.unlink', entityType: 'subject', entityId: subject._id,
    section: section._id,
    before: { subject: subject.name, groupName: before }, after: { subject: subject.name, groupName: null },
  });
  return { subjectId: subject._id, subject: subject.name, group: null };
}

/* ------------------------------ broadcasts ------------------------------- */

/**
 * Target-group resolution (owner request 2026-10-03):
 *   announcements + timetable  → the section's GENERAL group only;
 *   assignments + notes        → the POST'S SUBJECT's group when linked,
 *     with a FALLBACK to the general group so no post is ever silently
 *     dropped (a note may also carry no subject at all).
 * Returns the group { id, name } or null when nothing is linked.
 */
export async function resolveBroadcastGroup(sectionId, subjectId = null) {
  if (subjectId) {
    const subject = await Subject.findById(subjectId).select('whatsappGroup').lean();
    const g = subject?.whatsappGroup;
    if (g?.id) return { id: g.id, name: g.name };
  }
  const section = await Section.findById(sectionId).select('whatsappGroup').lean();
  const g = section?.whatsappGroup;
  return g?.id ? { id: g.id, name: g.name } : null;
}

/* Core send (NEVER throws): caption-carrying attachments ride the full post
 * text as the FIRST captionable attachment's caption — one file + text =
 * ONE WhatsApp message (2026-09-20 owner report). Audio can't carry a
 * caption, so audio-only (or no attachments) falls back to a chat message. */
async function sendBroadcast(groupId, message, attachments) {
  const list = Array.isArray(attachments) ? attachments.filter((a) => a?.url) : [];
  const hasCaptionable = list.some((a) => classifyAttachment(a) !== 'audio');
  if (hasCaptionable) {
    const { sentCount } = await sendAttachmentsToGroup(groupId, list, message);
    return { sent: true, mediaSent: sentCount };
  }
  await sendText(groupId, message);
  const { sentCount } = await sendAttachmentsToGroup(groupId, list);
  return { sent: true, mediaSent: sentCount };
}

/**
 * Sends `message` to the section's linked GENERAL WhatsApp group. NEVER
 * throws — returns { sent, reason } so callers can treat it as fire-safe.
 */
export async function broadcastToSectionGroup(sectionId, message, attachments = []) {
  try {
    if (!isConfigured()) return { sent: false, reason: 'not-configured' };
    const section = await Section.findById(sectionId).select('whatsappGroup');
    const g = section?.whatsappGroup;
    if (!g?.id) return { sent: false, reason: 'no-group' };
    return await sendBroadcast(g.id, message, attachments);
  } catch (err) {
    console.error('[whatsapp-group] broadcast failed:', err.message);
    return { sent: false, reason: 'error' };
  }
}

/**
 * Sends `message` to the SUBJECT's linked group, falling back to the
 * section's general group. NEVER throws — same contract as above.
 */
export async function broadcastToSubjectGroup(sectionId, subjectId, message, attachments = []) {
  try {
    if (!isConfigured()) return { sent: false, reason: 'not-configured' };
    const g = await resolveBroadcastGroup(sectionId, subjectId);
    if (!g) return { sent: false, reason: 'no-group' };
    return await sendBroadcast(g.id, message, attachments);
  } catch (err) {
    console.error('[whatsapp-group] broadcast failed:', err.message);
    return { sent: false, reason: 'error' };
  }
}

/**
 * Maps a verified FileMeta attachment to the right WhatsApp media type:
 * images → image message, audio → playable audio message, video → video
 * message, everything else (PDF/DOC/XLS/ZIP/…) → document message with the
 * original filename. mimeType is server-verified at upload confirmation, so
 * it is trustworthy for routing.
 */
function classifyAttachment(a) {
  const mime = String(a?.mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/ogg') return 'audio'; // .ogg audio variant
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * Sends each attachment to the group as REAL WhatsApp media — students get
 * the actual pic/PDF/voice in WhatsApp itself and never need to open the
 * app. Each file is best-effort: one failing attachment never stops the rest.
 * Returns the number of media messages delivered.
 */
async function sendAttachmentsToGroup(groupId, attachments, caption) {
  const list = Array.isArray(attachments) ? attachments.slice(0, 10) : []; // same cap as uploads
  let sentCount = 0;
  let remainingCaption = caption; // consumed by the FIRST attachment able to carry it
  let captionUsed = false;
  for (const a of list) {
    if (!a?.url) continue;
    try {
      const kind = classifyAttachment(a);
      const useCaption = remainingCaption && kind !== 'audio' ? remainingCaption : undefined;
      if (kind === 'image') await sendImage(groupId, a.url, useCaption);
      else if (kind === 'audio') await sendAudio(groupId, a.url);
      else if (kind === 'video') await sendVideo(groupId, a.url, useCaption);
      else await sendDocument(groupId, a.url, a.originalName, useCaption);
      if (useCaption) { remainingCaption = undefined; captionUsed = true; }
      sentCount += 1;
    } catch (err) {
      console.error(`[whatsapp-group] attachment broadcast failed (${a?.publicId ?? a?.originalName ?? 'unknown'}):`, err.message);
    }
  }
  return { sentCount, captionUsed };
}

/**
 * Broadcasts ONE freshly-confirmed attachment (announcement/note/assignment)
 * to its section's group. Used by the upload-confirmation hook — files are
 * attached AFTER the post is created, so each confirmed file goes out as its
 * own WhatsApp media message. Best-effort: NEVER throws.
 */
export async function broadcastAttachmentToSectionGroup(sectionId, attachment, subjectId = null) {
  try {
    if (!isConfigured()) return { sent: false, reason: 'not-configured' };
    // Files attached AFTER the post's broadcast go to the same destination
    // as the post itself: the subject's group (assignments/notes) or the
    // section's general group.
    const g = await resolveBroadcastGroup(sectionId, subjectId);
    if (!g) return { sent: false, reason: 'no-group' };
    const { sentCount } = await sendAttachmentsToGroup(g.id, [attachment]);
    return { sent: sentCount > 0, mediaSent: sentCount };
  } catch (err) {
    console.error('[whatsapp-group] attachment broadcast failed:', err.message);
    return { sent: false, reason: 'error' };
  }
}

/**
 * Explicit "send the whole post to the group NOW" — the CR portal creates a
 * post, uploads its files, then fires this once so the group receives the
 * text AND all attachments together in a single burst (owner request
 * 2026-09-20: no premature text-then-file double sends). Idempotent-ish:
 * marks groupBroadcastAt on success so later attach-confirmed files know the
 * initial broadcast already went out.
 */
export async function broadcastContentToGroup(req, { Model, kind, buildMessage }) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const id = v.assertObjectId(req.params.id, 'id');
  const doc = await Model.findOne({ _id: id, section: req.user.section, status: 'published' });
  if (!doc) throw new ApiError(404, `${kind} not found`);
  // Idempotency guard (2026-09-20): an explicit broadcast fires ONCE per post.
  // A second call must not duplicate the burst in the group.
  if (doc.groupBroadcastAt) return { sent: false, reason: 'already-broadcast', mediaSent: 0 };
  const message = await buildMessage(doc);
  // Announcements have no subject field → general group; notes/assignments
  // route to their subject's group with general-group fallback.
  const out = doc.subject
    ? await broadcastToSubjectGroup(doc.section, doc.subject, message, doc.attachments)
    : await broadcastToSectionGroup(doc.section, message, doc.attachments);
  if (out.sent) {
    doc.groupBroadcastAt = new Date();
    await doc.save();
  }
  await auditFromReq(req, {
    action: `${kind}.groupBroadcast`, entityType: kind, entityId: doc._id, section: doc.section,
    after: { sent: out.sent, reason: out.reason ?? null, mediaSent: out.mediaSent ?? 0 },
  });
  return out;
}

/* ---------------------------- message builders -------------------------- */

/**
 * Prepares free-text content (announcement/note/assignment body) for a
 * WhatsApp message. BUG FIXED 2026-09-22: this used to `replace(/\s+/g, ' ')`,
 * which collapses EVERY whitespace run — including blank lines between
 * paragraphs — into a single space. The app preserved the author's line
 * breaks; WhatsApp received one solid unreadable block (owner screenshot:
 * paragraphs typed with blank lines between them arrived as one run-on
 * paragraph). Fix: normalize line endings, collapse only HORIZONTAL
 * whitespace within each line, trim each line, then cap runs of 3+ newlines
 * (2+ blank lines) down to exactly one blank line — single and double
 * line breaks the author typed are preserved as typed.
 */
export function contentPreview(content, max = 200) {
  const normalized = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trimEnd()}…`;
}

export function announcementMessage(doc) {
  // Full content — the group receives EVERYTHING and never needs the app
  // link (owner request 2026-09-20). 3500 keeps us safely under WhatsApp's
  // 4096-char text limit even with the longest allowed announcement.
  // OWNER REQUEST (2026-10-04): NO auto label like "New announcement" — the
  // message starts directly with the CR's own title, then description.
  const lines = [`"${doc.title}"`];
  const full = contentPreview(doc.content, 3500);
  if (full) lines.push(``, full);
  return lines.join('\n');
}

export async function noteMessage(doc) {
  // OWNER REQUEST (2026-10-04): no "New note" label — title first, nothing extra.
  const lines = [`"${doc.title}"`];
  if (doc.subject) {
    const subject = await Subject.findById(doc.subject).select('name');
    if (subject) lines.push(``, `Subject: ${subject.name}`);
  }
  const full = contentPreview(doc.content, 3500);
  if (full) lines.push(``, full);
  return lines.join('\n');
}

export async function assignmentMessage(doc, subjectId) {
  const subject = subjectId ? await Subject.findById(subjectId).select('name') : null;
  // OWNER REQUEST (2026-10-04): no "New assignment" label — title first, then
  // subject/due/instructions, nothing extra bolted on.
  const lines = [`"${doc.title}"`];
  if (subject) lines.push(``, `Subject: ${subject.name}`);
  lines.push(``, `Due: ${PKT_DEADLINE_FMT.format(new Date(doc.deadline))} (PKT)`);
  const full = contentPreview(doc.instructions, 3500);
  if (full) lines.push(``, full);
  return lines.join('\n');
}

/**
 * One timetable slot changed. `verb` ∈ 'added' | 'updated' | 'cancelled'.
 * date/startTime/endTime are PKT wall-clock values exactly as stored.
 */
export async function timetableMessage({ verb, sectionId, subjectId, date, startTime, endTime, room }) {
  const subject = subjectId ? await Subject.findById(subjectId).select('name code') : null;
  const subj = subject ? subject.name : 'Class';
  const lines = [
    `📅 *Timetable updated*`,
    ``,
    `Class ${verb}: ${subj}`,
    `${fmtWallDate(date)} · ${fmt12(startTime)} – ${endTime ? fmt12(endTime) : '--:--'}`,
  ];
  if (room) lines.push(`Room: ${room}`);
  return lines.join('\n');
}

export function timetableCopyMessage({ copied, fromDate, toDate }) {
  const lines = [`📅 *Timetable updated*`, ``, `${copied} class${copied === 1 ? '' : 'es'} copied to ${fmtWallDate(toDate)}`];
  return lines.join('\n');
}
