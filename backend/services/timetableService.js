import mongoose from 'mongoose';
import { Timetable, Section, Subject, Notification } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import * as v from '../utils/validators.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';

/**
 * Timetable (Step 7) — DAILY class slots (one specific calendar date each).
 *
 * - date/startTime/endTime are Asia/Karachi wall-clock values (YYYY-MM-DD /
 *   HH:MM strings, zero-padded) — calendar data, NEVER UTC timestamps.
 * - A section cannot have two ACTIVE entries overlapping on the same date.
 *   Overlap = newStart < existingEnd AND newEnd > existingStart.
 *   Boundary-touching (end == next start) is allowed.
 * - CR can copy another day's slots into a target date in one call
 *   (conflicting slots are skipped, never silently overwritten).
 * - Concurrency: overlap check + insert run inside a MongoDB transaction that
 *   first touches the Section document — concurrent writers for the same
 *   section conflict on that document and the loser transparently retries,
 *   then sees the winner's entry. No lock collection needed.
 * - No hard delete; archived entries never block new active slots.
 */

// (DAYS export removed — timetable is date-based now)
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // strict zero-padded HH:MM 24h
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/; // strict YYYY-MM-DD
const ROOM_MAX = 40;

const hhmmToMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/* ------------------------------ validation ------------------------------ */

/** Strict YYYY-MM-DD calendar date — real calendar day (2026-02-31 rejected). */
function assertDate(value) {
  const d = String(value ?? '').trim();
  if (!DATE_RE.test(d)) throw new ApiError(400, 'date must be a valid YYYY-MM-DD date');
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) {
    throw new ApiError(400, 'date must be a valid calendar date');
  }
  return d;
}

/** Strict zero-padded HH:MM — rejects '8:00 AM', '25:00', '09:75', ''. */
function assertTime(value, field) {
  const t = String(value ?? '').trim();
  if (!TIME_RE.test(t)) throw new ApiError(400, `${field} must be a valid HH:MM 24-hour time`);
  return t;
}

function assertRange(startTime, endTime) {
  if (hhmmToMinutes(startTime) >= hhmmToMinutes(endTime)) {
    throw new ApiError(400, 'startTime must be before endTime');
  }
}

function assertRoom(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const room = String(value).trim();
  if (room.length > ROOM_MAX) throw new ApiError(400, `room must be at most ${ROOM_MAX} characters`);
  return room;
}

async function assertActiveSection(sectionId) {
  const id = v.assertObjectId(sectionId, 'section id');
  const section = await Section.findById(id);
  if (!section) throw new ApiError(400, 'Section not found');
  if (section.status !== 'active') throw new ApiError(400, 'Section is archived');
  return section;
}

/** Subject must exist, belong to `sectionId`, and be active. */
async function assertSectionSubject(subjectId, sectionId) {
  const id = v.assertObjectId(subjectId, 'subject id');
  const subject = await Subject.findById(id);
  if (!subject) throw new ApiError(400, 'Subject not found');
  if (String(subject.section) !== String(sectionId)) {
    throw new ApiError(400, 'Subject does not belong to this section');
  }
  if (subject.status !== 'active') throw new ApiError(400, 'Subject is archived');
  return id;
}

function overlapFilter({ section, date, startTime, endTime, excludeId }) {
  // zero-padded HH:MM strings compare correctly lexicographically
  return {
    section,
    date,
    status: 'active',
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  };
}

async function audit(req, action, { entityId, section, before, after }) {
  await auditFromReq(req, {
    action, entityType: 'timetable', entityId, section, before, after,
  });
}

/* -------------------------------- creates ------------------------------- */

async function createEntry(req, sectionId) {
  const body = v.pick(req.body, ['subject', 'date', 'startTime', 'endTime', 'room']);
  const section = await assertActiveSection(sectionId);
  const subject = await assertSectionSubject(body.subject, section._id);
  const date = assertDate(body.date);
  const startTime = assertTime(body.startTime, 'startTime');
  const endTime = assertTime(body.endTime, 'endTime');
  assertRange(startTime, endTime);
  const room = assertRoom(body.room);

  const doc = await withSectionLock(section._id, async (tx) => {
    const conflict = await Timetable.findOne(
      overlapFilter({ section: section._id, date, startTime, endTime }), null, { session: tx }
    );
    if (conflict) throw new ApiError(409, 'Timetable slot overlaps an existing class on this date.');
    const [created] = await Timetable.create([{
      section: section._id, subject, date, startTime, endTime, room,
      createdBy: req.user._id, status: 'active',
    }], { session: tx });
    return created;
  });

  await audit(req, 'timetable.create', {
    entityId: doc._id, section: doc.section,
    after: { date, startTime, endTime, subject: String(subject) },
  });
  return doc;
}

export function createTimetableAdmin(req) {
  // admin explicitly selects a section — still validated against the DB
  return createEntry(req, v.pick(req.body, ['section']).section);
}

export async function createTimetableCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  // body.section/sectionId/createdBy/role/status are never read for CR
  return createEntry(req, req.user.section);
}

/**
 * Copy another day's ACTIVE slots into a target date — the CR's daily
 * convenience ("kal ka schedule aaj bhi copy karo"). Slots that would
 * overlap an existing active slot on the target date are SKIPPED (never
 * silently overwritten). Same-date copies and missing source days are
 * explicit errors, not silent no-ops.
 */
export async function copyTimetableCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const body = v.pick(req.body, ['fromDate', 'toDate']);
  const fromDate = assertDate(body.fromDate);
  const toDate = assertDate(body.toDate);
  if (fromDate === toDate) throw new ApiError(400, 'fromDate and toDate must be different dates');
  await assertActiveSection(req.user.section);

  const source = await Timetable.find({
    section: req.user.section, date: fromDate, status: 'active',
  }).sort({ startTime: 1 });
  if (!source.length) throw new ApiError(400, `No active classes found on ${fromDate} to copy`);

  let copied = 0;
  const skipped = [];
  for (const slot of source) {
    const conflict = await Timetable.findOne(
      overlapFilter({ section: req.user.section, date: toDate, startTime: slot.startTime, endTime: slot.endTime })
    );
    if (conflict) { skipped.push({ startTime: slot.startTime, endTime: slot.endTime }); continue; }
    await Timetable.create({
      section: req.user.section, subject: slot.subject, date: toDate,
      startTime: slot.startTime, endTime: slot.endTime, room: slot.room,
      createdBy: req.user._id, status: 'active',
    });
    copied += 1;
  }

  await auditFromReq(req, {
    action: 'timetable.copy', entityType: 'timetable', section: req.user.section,
    before: null, after: { fromDate, toDate, copied, skipped: skipped.length },
  });
  return { copied, skipped, fromDate, toDate };
}

/* --------------------------------- lists -------------------------------- */

function timetableFilters(query, { forceSection }) {
  const filter = {};
  if (forceSection) filter.section = forceSection;
  const sectionParam = query.sectionId ?? query.section;
  if (sectionParam) filter.section = v.assertObjectId(sectionParam, 'section id');
  if (query.subjectId) filter.subject = v.assertObjectId(query.subjectId, 'subject id');
  if (query.date !== undefined) {
    const d = String(query.date).trim();
    if (d) filter.date = assertDate(d);
  }
  if (query.status) filter.status = v.assertEnum(query.status, ['active', 'archived'], 'status');
  return filter;
}

/**
 * Deterministic ordering: date, then startTime, endTime, _id.
 * Wall-clock strings are returned EXACTLY as stored (no UTC conversion).
 */
async function listEntries(filter, query) {
  const { page, limit, skip } = parsePagination(query);
  const [rows] = await Timetable.aggregate([
    { $match: filter },
    { $sort: { date: -1, startTime: 1, endTime: 1, _id: 1 } },
    { $facet: {
      items: [
        { $skip: skip },
        { $limit: limit },
        { $lookup: { from: 'subjects', localField: 'subject', foreignField: '_id', as: 'subject' } },
        { $unwind: '$subject' },
        { $lookup: { from: 'users', localField: 'createdBy', foreignField: '_id', as: 'createdBy' } },
        { $unwind: { path: '$createdBy', preserveNullAndEmptyArrays: true } },
        { $project: {
          section: 1, subject: { name: 1, code: 1 }, date: 1, startTime: 1, endTime: 1,
          room: 1, status: 1, createdBy: { name: 1 }, createdAt: 1, updatedAt: 1,
        } },
      ],
      total: [{ $count: 'count' }],
    } },
  ]);
  const total = rows?.total?.[0]?.count ?? 0;
  return { items: rows?.items ?? [], pagination: paginationMeta(total, { page, limit }) };
}

export async function listTimetableAdmin(req) {
  return listEntries(timetableFilters(req.query, {}), req.query);
}

export async function listTimetableCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  // CR filters: subjectId, day, status only — section is ALWAYS server-derived
  return listEntries(
    timetableFilters({ ...req.query, sectionId: undefined, section: undefined },
      { forceSection: req.user.section }),
    req.query
  );
}

export async function listTimetableStudent(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  // student-supplied sectionId is never accepted for ownership
  return listEntries(
    timetableFilters({ ...req.query, sectionId: undefined, section: undefined },
      { forceSection: req.user.section }),
    req.query
  );
}

/* ------------------------------ get by id ------------------------------- */

const POPULATES = [['subject', 'name code'], ['createdBy', 'name']];

async function populateDoc(doc) {
  for (const [path, select] of POPULATES) await doc.populate(path, select);
  return doc;
}

export async function getTimetableAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'timetable entry id');
  const doc = await Timetable.findById(id);
  if (!doc) throw new ApiError(404, 'Timetable entry not found');
  return populateDoc(doc);
}

async function findOwnEntry(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const id = v.assertObjectId(req.params.id, 'timetable entry id');
  const doc = await Timetable.findOne({ _id: id, section: req.user.section });
  if (!doc) throw new ApiError(404, 'Timetable entry not found'); // cross-section = missing
  return doc;
}

export async function getTimetableCr(req) {
  return populateDoc(await findOwnEntry(req));
}

export async function getTimetableStudent(req) {
  return populateDoc(await findOwnEntry(req));
}

/* -------------------------------- updates ------------------------------- */

/**
 * Section-doc write lock + overlap check + save, all inside one transaction.
 * `withTransaction` transparently retries on write conflicts, so a concurrent
 * writer for the same section always re-checks overlap after losing the race.
 */
async function withSectionLock(sectionId, fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async (tx) => {
      // touch the Section doc → serializes concurrent timetable writes per section
      await Section.updateOne({ _id: sectionId }, { $set: { updatedAt: new Date() } }, { session: tx });
      result = await fn(tx);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function applyUpdate(req, doc, { scoped }) {
  const body = v.pick(req.body, ['subject', 'date', 'startTime', 'endTime', 'room', 'section']);
  if (doc.status === 'archived') throw new ApiError(400, 'Archived timetable entry cannot be modified');

  // Section moves: never for CR (body.section ignored); admin may move an
  // entry to another ACTIVE section only together with a valid subject of
  // that section. Overlap is re-validated in the destination.
  let targetSection = doc.section;
  if (!scoped && body.section !== undefined) {
    targetSection = (await assertActiveSection(body.section))._id;
    if (String(targetSection) !== String(doc.section) && body.subject === undefined) {
      throw new ApiError(400, 'Moving to another section requires a subject belonging to that section');
    }
  }

  const fields = {};
  if (body.subject !== undefined) fields.subject = await assertSectionSubject(body.subject, targetSection);
  if (body.date !== undefined) fields.date = assertDate(body.date);
  if (body.startTime !== undefined) fields.startTime = assertTime(body.startTime, 'startTime');
  if (body.endTime !== undefined) fields.endTime = assertTime(body.endTime, 'endTime');
  if (body.room !== undefined) fields.room = assertRoom(body.room);

  const date = fields.date ?? doc.date;
  const startTime = fields.startTime ?? doc.startTime;
  const endTime = fields.endTime ?? doc.endTime;
  assertRange(startTime, endTime);

  const before = { date: doc.date, startTime: doc.startTime, endTime: doc.endTime };
  const updated = await withSectionLock(targetSection, async (tx) => {
    const conflict = await Timetable.findOne(
      overlapFilter({ section: targetSection, date, startTime, endTime, excludeId: doc._id }),
      null, { session: tx }
    );
    if (conflict) throw new ApiError(409, 'Timetable slot overlaps an existing class on this date.');
    Object.assign(doc, fields, { section: targetSection });
    await doc.save({ session: tx });
    return doc;
  });

  await audit(req, 'timetable.update', {
    entityId: doc._id, section: doc.section, before,
    after: { date, startTime, endTime },
  });
  return updated;
}

export async function updateTimetableAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'timetable entry id');
  const doc = await Timetable.findById(id);
  if (!doc) throw new ApiError(404, 'Timetable entry not found');
  return applyUpdate(req, doc, { scoped: false });
}

export async function updateTimetableCr(req) {
  const doc = await findOwnEntry(req);
  return applyUpdate(req, doc, { scoped: true });
}

/* -------------------------------- archive ------------------------------- */

async function archiveEntry(req, doc) {
  if (doc.status === 'archived') throw new ApiError(409, 'Timetable entry already archived');
  doc.status = 'archived';
  await doc.save(); // section, subject, date, times, room, createdBy, timestamps preserved
  await audit(req, 'timetable.archive', {
    entityId: doc._id, section: doc.section,
    before: { status: 'active' }, after: { status: 'archived' },
  });
  return doc;
}

/** Hard delete — attendance sessions reference the section, not the slot, so removal is safe. */
async function deleteEntry(req, doc) {
  await Notification.deleteMany({ refType: 'Timetable', refId: doc._id });
  await doc.deleteOne();
  await auditFromReq(req, {
    action: 'timetable.delete', entityType: 'timetable', entityId: doc._id, section: doc.section,
    before: { subject: doc.subject, date: doc.date, startTime: doc.startTime }, after: { deleted: true },
  });
  return { deleted: true, id: doc._id };
}

export async function deleteTimetableAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'timetable entry id');
  const doc = await Timetable.findById(id);
  if (!doc) throw new ApiError(404, 'Timetable entry not found');
  return deleteEntry(req, doc);
}

export async function deleteTimetableCr(req) {
  return deleteEntry(req, await findOwnEntry(req));
}

export async function archiveTimetableAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'timetable entry id');
  const doc = await Timetable.findById(id);
  if (!doc) throw new ApiError(404, 'Timetable entry not found');
  return archiveEntry(req, doc);
}

export async function archiveTimetableCr(req) {
  return archiveEntry(req, await findOwnEntry(req));
}
