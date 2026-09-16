import { Notification, User, Section, Assignment, Timetable } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { audit } from '../utils/audit.js';
import { now, nowDate, karachiWallClock, karachiDateKey } from '../utils/clock.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import * as v from '../utils/validators.js';

/**
 * Centralized in-app notification service.
 *
 * TRUST MODEL — notifications are created ONLY server-side (by content
 * services and lazy reminder generation). There is NO client-facing route
 * that creates a notification, so recipient / section / dedupeKey / createdAt
 * / read-state injection is structurally impossible, not merely filtered.
 *
 * DEDUPLICATION — every creation path carries a deterministic server-generated
 * dedupeKey. The partial unique index {recipient, dedupeKey} is the true
 * arbiter: concurrent creators (retries, parallel serverless instances) can
 * never produce duplicates, and E11000 races are swallowed here so they can
 * never reach a client.
 *
 * RETENTION — expiresAt = createdAt + 90 days; the existing TTL index
 * {expiresAt: 1, expireAfterSeconds: 0} self-deletes old documents. No
 * manual cleanup exists anywhere in this service.
 */

// Types are the model's enum — the single source of truth. Extensible by
// adding a value to the schema enum only; clients can never supply types.
const TYPE_ENUM = ['announcement', 'assignment', 'note', 'timetable', 'attendance', 'reminder', 'system'];

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90-day in-app retention
const TITLE_MAX = 120;
const MESSAGE_MAX = 500;

/** Safe field projection for ANY client-facing notification response. */
const SAFE_FIELDS = '-dedupeKey -expiresAt -__v';

function assertType(type) {
  if (!TYPE_ENUM.includes(type)) throw new ApiError(400, 'Invalid notification type');
  return type;
}

function safeTitle(value) {
  const title = String(value ?? '').trim();
  return title.slice(0, TITLE_MAX); // content services already validate; truncate defensively
}

function safeMessage(value) {
  const message = String(value ?? '').trim();
  return message.slice(0, MESSAGE_MAX);
}

function assertRecipient(recipient) {
  if (!v.isValidObjectId(recipient)) throw new ApiError(400, 'Invalid notification recipient');
  return recipient;
}

/* ------------------------------ creation ------------------------------- */

/**
 * Single-notification creation with DB-level idempotency.
 * Returns the created document, or null when the dedupeKey already exists
 * (a retry is a silent no-op — duplicate-key errors NEVER propagate).
 */
export async function createNotification({
  recipient, type, title, message, refType, refId, dedupeKey,
}) {
  assertRecipient(recipient);
  assertType(type);
  if (!dedupeKey) throw new ApiError(400, 'Missing dedupe key');

  const doc = {
    recipient,
    type,
    title: safeTitle(title),
    message: safeMessage(message),
    refType: refType ? String(refType).trim() : undefined,
    refId: v.isValidObjectId(refId) ? refId : undefined,
    dedupeKey: String(dedupeKey),
    read: false,
    expiresAt: new Date(now() + RETENTION_MS),
  };
  try {
    return await Notification.create(doc);
  } catch (err) {
    if (err?.code === 11000 || err?.code === 11000n) return null; // concurrent duplicate — first writer wins
    if (err?.name === 'MongoBulkWriteError' && err?.code === 11000) return null;
    throw err;
  }
}

/**
 * Bulk creation (unordered). Recipients are ALWAYS server-derived.
 * Duplicate-key write errors are filtered out — the unique index guarantees
 * exactly-once delivery per recipient; the caller gets the inserted count.
 */
export async function createManyNotifications(docs) {
  if (!docs.length) return 0;
  const prepared = docs.map((d) => ({
    recipient: assertRecipient(d.recipient),
    type: assertType(d.type),
    title: safeTitle(d.title),
    message: safeMessage(d.message),
    refType: d.refType ? String(d.refType).trim() : undefined,
    refId: v.isValidObjectId(d.refId) ? d.refId : undefined,
    dedupeKey: String(d.dedupeKey),
    read: false,
    expiresAt: new Date(now() + RETENTION_MS),
  }));
  try {
    const res = await Notification.insertMany(prepared, { ordered: false, rawResult: true });
    return res?.insertedCount ?? prepared.length;
  } catch (err) {
    // Driver shape (MongoBulkWriteError): top-level code 11000 when every
    // write error is a duplicate; per-writeError `code` is often undefined, so
    // match on errmsg too. Any NON-duplicate failure must propagate.
    // Driver shape: writeErrors[].code is undefined; the real code sits on
    // writeErrors[].err.code — both shapes are matched here.
    const isDup = (e) => e.code === 11000 || e.code === 11000n
      || e?.err?.code === 11000 || e?.err?.code === 11000n;
    const writeErrors = err?.writeErrors ?? [];
    const allDupes = writeErrors.length > 0
      ? writeErrors.every(isDup)
      : (err?.code === 11000 || err?.code === 11000n);
    if (allDupes) return err.result?.insertedCount ?? (prepared.length - writeErrors.length);
    throw err;
  }
}

/**
 * Fan-out helper for section events (announcement/assignment posted).
 * Recipients are derived server-side from CURRENT membership:
 *   - active students of the section
 *   - the section's CR, unless the CR is the actor (authors don't self-notify)
 * Suspended / pending users and other sections are structurally excluded.
 * Per-recipient dedupe key: `<prefix>:<refId>:<recipientId>` — idempotent
 * under any retry. One aggregate audit event per fan-out (no per-recipient noise).
 */
export async function notifySection({
  req, section, actorId, type, title, message, refType, refId, dedupePrefix,
}) {
  const sectionId = v.assertObjectId(section, 'section id');
  assertType(type);
  if (!dedupePrefix) throw new ApiError(400, 'Missing dedupe prefix');

  // CURRENT active members only — a student rolled over to another section
  // is no longer in this query and receives nothing new.
  const recipients = await User.find(
    { section: sectionId, registrationStatus: 'active', role: 'student' },
    { _id: 1 },
  ).lean();
  const ids = recipients.map((u) => u._id);

  // Section CR and GR are members too — but never the acting author.
  const sec = await Section.findById(sectionId).select('cr gr').lean();
  for (const repId of [sec?.cr, sec?.gr]) {
    if (repId && String(repId) !== String(actorId)) {
      const repUser = await User.findOne(
        { _id: repId, registrationStatus: 'active' },
        { _id: 1 },
      ).lean();
      if (repUser && !ids.some((id) => String(id) === String(repUser._id))) ids.push(repUser._id);
    }
  }
  if (!ids.length) return 0;

  const inserted = await createManyNotifications(
    ids.map((recipientId) => ({
      recipient: recipientId,
      type,
      title,
      message,
      refType,
      refId,
      dedupeKey: `${dedupePrefix}:${refId}:${recipientId}`,
    })),
  );

  await audit({
    actor: actorId ?? null,
    actorRole: req?.user?.role ?? 'system',
    action: 'notification.create',
    entityType: type,
    entityId: refId,
    section: sectionId,
    after: { type, title: safeTitle(title), recipients: ids.length, inserted },
    ip: req?.ip,
    userAgent: req?.get?.('user-agent'),
  });
  return inserted;
}

/* --------------------------- lazy reminders ----------------------------- */

/**
 * Timetable class reminders — locked lazy-generation design.
 *
 * Generated ONLY when the recipient polls their notification endpoints
 * (no background worker). A reminder is due when, in Asia/Karachi local
 * time, TODAY's date matches the slot's date AND the wall clock is within
 * [startTime − 30m, startTime). The dedupe key uses the KARACHI-LOCAL
 * date — never UTC. Idempotent across any number of polls and concurrent
 * serverless instances via the unique {recipient, dedupeKey} index.
 */
export async function generateTimetableReminders(user) {
  if (!user?.section) return 0;
  const { dateStr, minutes } = karachiWallClock();

  const section = await Section.findById(user.section).select('status').lean();
  if (!section || section.status !== 'active') return 0; // archived sections get no reminders

  // Daily timetable — every slot is bound to one concrete date
  const slots = await Timetable.find({ section: user.section, date: dateStr, status: 'active' })
    .populate('subject', 'name')
    .lean();
  const due = slots.filter((slot) => {
    const [h, m] = slot.startTime.split(':').map(Number);
    const startMinutes = h * 60 + m;
    return minutes >= startMinutes - 30 && minutes < startMinutes; // the 30-minute window
  });
  if (!due.length) return 0;

  const docs = due.map((slot) => ({
    recipient: user._id,
    type: 'timetable',
    title: 'Class starting soon',
    message: `${slot.subject?.name ?? 'Class'} starts at ${slot.startTime}${slot.room ? ` — Room ${slot.room}` : ''}`,
    refType: 'Timetable',
    refId: slot._id,
    // Karachi-local date key — see karachiWallClock()
    dedupeKey: `reminder:${slot._id}:${dateStr}`,
  }));
  return createManyNotifications(docs);
}

/**
 * Assignment deadline reminders — same lazy poll-driven pattern.
 * Due when a published assignment's deadline (UTC, server clock) is within
 * the next 24 hours. Dedupe key includes the Karachi-local date, so at most
 * one reminder per recipient per assignment per calendar day — repeated
 * polls are silent no-ops.
 */
export async function generateDeadlineReminders(user) {
  if (!user?.section) return 0;
  const deadlineWindowEnd = now() + 24 * 60 * 60 * 1000;

  const assignments = await Assignment.find({
    section: user.section,
    status: 'published',
    deadline: { $gt: new Date(now()), $lte: new Date(deadlineWindowEnd) },
  }).lean();

  const dateStr = karachiDateKey();
  const docs = assignments.map((a) => ({
    recipient: user._id,
    type: 'reminder',
    title: 'Assignment deadline approaching',
    message: `"${String(a.title).slice(0, 80)}" is due within 24 hours`,
    refType: 'Assignment',
    refId: a._id,
    dedupeKey: `assignment_deadline:${a._id}:${dateStr}:${user._id}`,
  }));
  return createManyNotifications(docs);
}

/**
 * Runs both lazy generators for the polling user. Reminder generation is
 * best-effort: a failure can never break the poll endpoint itself.
 */
async function generateDueReminders(user) {
  try {
    // Only CURRENT active members receive reminders. The auth middleware
    // already blocks suspended/pending users, but a rollover or status
    // change between auth and here must never produce stale reminders.
    if (user?.registrationStatus && user.registrationStatus !== 'active') return 0;
    const t = await generateTimetableReminders(user);
    const d = await generateDeadlineReminders(user);
    if (t + d > 0) {
      await audit({
        actor: user._id,
        actorRole: user.role,
        action: 'notification.generate',
        entityType: 'reminder',
        after: { timetable: t, deadline: d }, // aggregate event — no payload noise
      });
    }
    return t + d;
  } catch (err) {
    console.error('[notifications] reminder generation failed:', err.message);
    return 0;
  }
}

/* ------------------------------ read APIs ------------------------------ */

/** Lists the CURRENT user's notifications, newest first. */
export async function listMyNotifications(req) {
  await generateDueReminders(req.user);
  const { page, limit, skip } = parsePagination(req.query, { limit: 20 });
  const filter = { recipient: req.user._id };
  if (req.query.unread === 'true') filter.read = false;

  const [items, total] = await Promise.all([
    Notification.find(filter).select(SAFE_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(total, { page, limit }) };
}

/** Efficient unread count for the CURRENT user. */
export async function countMyUnread(req) {
  await generateDueReminders(req.user);
  const count = await Notification.countDocuments({ recipient: req.user._id, read: false });
  return { count };
}

/**
 * Mark one notification read. Cross-user ids resolve to 404 (existence must
 * not leak); re-reading an already-read notification is an idempotent no-op.
 */
export async function markMyNotificationRead(req) {
  const id = v.assertObjectId(req.params.id, 'notification id');
  const doc = await Notification.findOne({ _id: id, recipient: req.user._id });
  if (!doc) throw new ApiError(404, 'Notification not found');

  if (!doc.read) {
    doc.read = true;
    doc.readAt = nowDate();
    await doc.save();
    await audit({
      actor: req.user._id, actorRole: req.user.role,
      action: 'notification.read', entityType: 'notification', entityId: doc._id,
    });
  }
  return doc;
}

/** Marks ALL of the current user's unread notifications read. */
export async function markAllMyNotificationsRead(req) {
  const res = await Notification.updateMany(
    { recipient: req.user._id, read: false },
    { $set: { read: true, readAt: nowDate() } },
  );
  if (res.modifiedCount > 0) {
    await audit({
      actor: req.user._id, actorRole: req.user.role,
      action: 'notification.read_all', entityType: 'notification',
      after: { count: res.modifiedCount },
    });
  }
  return { count: res.modifiedCount };
}

/* --------------------------- admin (read-only) -------------------------- */

/**
 * Minimal read-only admin visibility: list + filter by recipient/type/read.
 * There is deliberately NO admin mutation route — an admin can never alter
 * another user's read state or any notification content.
 */
export async function listNotificationsAdmin(req) {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.recipient) filter.recipient = v.assertObjectId(req.query.recipient, 'recipient id');
  if (req.query.type) filter.type = v.assertEnum(req.query.type, TYPE_ENUM, 'type');
  if (req.query.read === 'true') filter.read = true;
  if (req.query.read === 'false') filter.read = false;

  const [items, total] = await Promise.all([
    Notification.find(filter).select(SAFE_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(total, { page, limit }) };
}
