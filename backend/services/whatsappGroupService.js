import { Section, Subject } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import { sendText, sendImage, sendDocument, sendAudio, sendVideo, listGroups, isConfigured } from './whatsappService.js';
import { normalizeWhatsApp } from './teacherService.js';
import { env } from '../config/env.js';
import * as v from '../utils/validators.js';

/**
 * WhatsApp group broadcasts — each section can link ONE class WhatsApp group
 * (the paired Tri3M number must be a member of it). When the section's CR/GR
 * posts content, a formatted message is delivered to that group.
 *
 * Scope (owner-confirmed 2026-09-20): announcements, assignments, notes and
 * timetable changes are broadcast. MARKS ARE NEVER BROADCAST — excluded per
 * owner's explicit instruction.
 *
 * Every broadcast is best-effort: it loads the section's linked group and
 * sends via the existing UltraMsg gateway. Failures are logged and swallowed
 * — a group message can never break the user's create/update flow.
 */

const APP_URL = process.env.APP_URL || 'https://iubcr.vercel.app';
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
  return {
    group: g && g.id ? { id: g.id, name: g.name, linkedAt: g.linkedAt } : null,
    instanceNumber: env.whatsapp.instanceNumber || null,
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

export async function linkGroupCr(req) {
  const section = await ownSection(req);
  const body = v.pick(req.body, ['groupId', 'groupName']);
  const id = v.assertText(body.groupId, 'groupId').trim();
  if (!GROUP_ID_RE.test(id)) throw new ApiError(400, 'Invalid WhatsApp group id');

  // Security: only groups that contain the CR's OWN registered number can be
  // linked — the client cannot inject another section's group id/name.
  const all = await listGroups();
  const { phone, groups: mine } = myGroups(all, req.user);
  const group = mine.find((g) => g.id === id);
  if (!phone) {
    throw new ApiError(400, 'Your profile has no WhatsApp number — ask the admin to add it first');
  }
  if (!group) {
    throw new ApiError(400, 'You can only link a group that contains your own WhatsApp number');
  }
  const name = String(group.name || 'Group').trim().slice(0, 100);

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

/* ------------------------------ broadcasts ------------------------------- */

/**
 * Sends `message` to the section's linked WhatsApp group. NEVER throws —
 * returns { sent, reason } so callers can treat it as fire-safe.
 */
export async function broadcastToSectionGroup(sectionId, message, attachments = []) {
  try {
    if (!isConfigured()) return { sent: false, reason: 'not-configured' };
    const section = await Section.findById(sectionId).select('whatsappGroup');
    const g = section?.whatsappGroup;
    if (!g?.id) return { sent: false, reason: 'no-group' };
    await sendText(g.id, message);
    const mediaSent = await sendAttachmentsToGroup(g.id, attachments);
    return { sent: true, mediaSent };
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
async function sendAttachmentsToGroup(groupId, attachments) {
  const list = Array.isArray(attachments) ? attachments.slice(0, 10) : []; // same cap as uploads
  let sentCount = 0;
  for (const a of list) {
    if (!a?.url) continue;
    try {
      const kind = classifyAttachment(a);
      if (kind === 'image') await sendImage(groupId, a.url);
      else if (kind === 'audio') await sendAudio(groupId, a.url);
      else if (kind === 'video') await sendVideo(groupId, a.url);
      else await sendDocument(groupId, a.url, a.originalName);
      sentCount += 1;
    } catch (err) {
      console.error(`[whatsapp-group] attachment broadcast failed (${a?.publicId ?? a?.originalName ?? 'unknown'}):`, err.message);
    }
  }
  return sentCount;
}

/**
 * Broadcasts ONE freshly-confirmed attachment (announcement/note/assignment)
 * to its section's group. Used by the upload-confirmation hook — files are
 * attached AFTER the post is created, so each confirmed file goes out as its
 * own WhatsApp media message. Best-effort: NEVER throws.
 */
export async function broadcastAttachmentToSectionGroup(sectionId, attachment) {
  try {
    if (!isConfigured()) return { sent: false, reason: 'not-configured' };
    const section = await Section.findById(sectionId).select('whatsappGroup');
    const g = section?.whatsappGroup;
    if (!g?.id) return { sent: false, reason: 'no-group' };
    const sentCount = await sendAttachmentsToGroup(g.id, [attachment]);
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
  const message = await buildMessage(doc);
  const out = await broadcastToSectionGroup(doc.section, message, doc.attachments);
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

function contentPreview(content, max = 200) {
  const flat = String(content ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

export function announcementMessage(doc) {
  // Full content — the group receives EVERYTHING and never needs the app
  // link (owner request 2026-09-20). 3500 keeps us safely under WhatsApp's
  // 4096-char text limit even with the longest allowed announcement.
  const lines = [`📢 *New announcement*`, ``, `"${doc.title}"`];
  const full = contentPreview(doc.content, 3500);
  if (full) lines.push(``, full);
  return lines.join('\n');
}

export async function noteMessage(doc) {
  const lines = [`📄 *New note*`, ``, `"${doc.title}"`];
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
  const lines = [`📋 *New assignment*`, ``, `"${doc.title}"`];
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
