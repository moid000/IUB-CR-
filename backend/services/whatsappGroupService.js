import { Section, Subject } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import { sendText, listGroups, isConfigured } from './whatsappService.js';
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

/** Fresh group list straight from the gateway — the CR's "Refresh" button. */
export async function refreshGroupsCr(req) {
  await ownSection(req); // a sectionless CR/GR can never configure broadcasts
  const groups = await listGroups();
  return { groups };
}

export async function linkGroupCr(req) {
  const section = await ownSection(req);
  const body = v.pick(req.body, ['groupId', 'groupName']);
  const id = v.assertText(body.groupId, 'groupId').trim();
  const name = v.assertText(body.groupName, 'groupName').trim();
  if (!GROUP_ID_RE.test(id)) throw new ApiError(400, 'Invalid WhatsApp group id');
  if (name.length < 1 || name.length > 100) throw new ApiError(400, 'Group name must be 1–100 characters');

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
export async function broadcastToSectionGroup(sectionId, message) {
  try {
    if (!isConfigured()) return { sent: false, reason: 'not-configured' };
    const section = await Section.findById(sectionId).select('whatsappGroup');
    const g = section?.whatsappGroup;
    if (!g?.id) return { sent: false, reason: 'no-group' };
    await sendText(g.id, message);
    return { sent: true };
  } catch (err) {
    console.error('[whatsapp-group] broadcast failed:', err.message);
    return { sent: false, reason: 'error' };
  }
}

/* ---------------------------- message builders -------------------------- */

function contentPreview(content, max = 200) {
  const flat = String(content ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

export function announcementMessage(doc) {
  const lines = [`📢 *New announcement*`, ``, `"${doc.title}"`];
  const preview = contentPreview(doc.content);
  if (preview) lines.push(``, preview);
  lines.push(``, `Open Tri3M: ${APP_URL}`);
  return lines.join('\n');
}

export async function noteMessage(doc) {
  const lines = [`📄 *New note*`, ``, `"${doc.title}"`];
  if (doc.subject) {
    const subject = await Subject.findById(doc.subject).select('name');
    if (subject) lines.push(``, `Subject: ${subject.name}`);
  }
  lines.push(``, `Open Tri3M: ${APP_URL}`);
  return lines.join('\n');
}

export async function assignmentMessage(doc, subjectId) {
  const subject = subjectId ? await Subject.findById(subjectId).select('name') : null;
  const lines = [`📋 *New assignment*`, ``, `"${doc.title}"`];
  if (subject) lines.push(``, `Subject: ${subject.name}`);
  lines.push(``, `Due: ${PKT_DEADLINE_FMT.format(new Date(doc.deadline))} (PKT)`);
  lines.push(``, `Open Tri3M: ${APP_URL}`);
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
  lines.push(``, `Open Tri3M: ${APP_URL}`);
  return lines.join('\n');
}

export function timetableCopyMessage({ copied, fromDate, toDate }) {
  const lines = [`📅 *Timetable updated*`, ``, `${copied} class${copied === 1 ? '' : 'es'} copied to ${fmtWallDate(toDate)}`];
  lines.push(``, `Open Tri3M: ${APP_URL}`);
  return lines.join('\n');
}
