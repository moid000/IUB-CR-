import { Assignment, Submission, Section, Subject, Notification } from '../models/index.js';
import { destroyAttachmentMetas } from './fileService.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import * as v from '../utils/validators.js';

const assertText = v.assertText;
import { parsePagination, paginationMeta, searchFilter } from '../utils/pagination.js';
import { now, nowDate } from '../utils/clock.js';
import { notifySection } from './notificationService.js';
import { broadcastToSectionGroup, broadcastContentToGroup, assignmentMessage } from './whatsappGroupService.js';

/**
 * Assignments + Submissions (Step 6).
 *
 * Assignment: section-scoped, subject-scoped (subject must belong to the same
 * section and be active). No hard delete; archived assignments cannot be
 * edited and cannot accept new submissions.
 *
 * Submission: exactly ONE per student per assignment (DB unique index).
 * Deadline enforcement is server-time only: eligible iff now() <= deadline.
 * All ownership (section, student, createdBy, uploadedBy) is server-derived.
 */

const TITLE_MAX = 120;
const INSTRUCTIONS_MAX = 8000;
const TEXT_MAX = 10000;

/* ------------------------------ validation ------------------------------ */

function assertTitle(value) {
  const title = assertText(value, 'title').trim();
  if (!title || title.length > TITLE_MAX) throw new ApiError(400, `Title must be 1–${TITLE_MAX} characters`);
  return title;
}

function assertInstructions(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = assertText(value, 'instructions').trim();
  if (text.length > INSTRUCTIONS_MAX) throw new ApiError(400, `Instructions must be at most ${INSTRUCTIONS_MAX} characters`);
  return text;
}

/** ISO-8601 UTC timestamp — invalid/unparseable dates are rejected with 400. */
function assertDeadline(value) {
  if (value === undefined || value === null || value === '') {
    throw new ApiError(400, 'Invalid deadline');
  }
  return v.assertDate(value, 'deadline'); // ISO-8601, stored as UTC
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

async function assertActiveSection(sectionId) {
  const id = v.assertObjectId(sectionId, 'section id');
  const section = await Section.findById(id);
  if (!section) throw new ApiError(400, 'Section not found');
  if (section.status !== 'active') throw new ApiError(400, 'Section is archived');
  return section;
}

/** Server-computed deadline state — the ONLY source of lock/eligibility truth. */
function withDeadlineState(doc) {
  return { ...doc.toJSON(), deadlinePassed: now() > new Date(doc.deadline).getTime() };
}

async function audit(req, action, { entityType, entityId, section, before, after }) {
  await auditFromReq(req, { action, entityType, entityId, section, before, after });
}

/* ------------------------------ ASSIGNMENTS ----------------------------- */

/** New assignment → in-app notification for active section students. */
function notifyAssignmentCreated(req, doc) {
  return notifySection({
    req,
    section: doc.section,
    actorId: req.user._id,
    type: 'assignment',
    title: 'New assignment',
    message: `"${doc.title}" — due ${doc.deadline.toISOString().slice(0, 10)}`,
    refType: 'Assignment',
    refId: doc._id,
    dedupePrefix: 'assignment',
  }).catch((err) => console.error('[notifications] assignment fan-out failed:', err.message));
}

export async function createAssignmentAdmin(req) {
  const body = v.pick(req.body, ['section', 'subject', 'title', 'instructions', 'deadline']);
  const section = await assertActiveSection(body.section);
  const subject = await assertSectionSubject(body.subject, section._id);
  const fields = {
    title: assertTitle(body.title),
    instructions: assertInstructions(body.instructions),
    deadline: assertDeadline(body.deadline),
  };
  const doc = await Assignment.create({
    ...fields, subject, section: section._id, createdBy: req.user._id, status: 'published',
  });
  await audit(req, 'assignment.create', {
    entityType: 'assignment', entityId: doc._id, section: doc.section,
    after: { title: doc.title, subject: String(subject), deadline: doc.deadline.toISOString() },
  });
  await notifyAssignmentCreated(req, doc); // updates/archives never re-notify
  await broadcastToSectionGroup(doc.section, await assignmentMessage(doc, subject), doc.attachments); // WhatsApp class-group (best-effort)
  return doc;
}

/** CR create — section is ALWAYS req.user.section; body.section never read. */
export async function createAssignmentCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const section = await assertActiveSection(req.user.section);
  const body = v.pick(req.body, ['subject', 'title', 'instructions', 'deadline']);
  const subject = await assertSectionSubject(body.subject, section._id);
  const doc = await Assignment.create({
    title: assertTitle(body.title),
    instructions: assertInstructions(body.instructions),
    deadline: assertDeadline(body.deadline),
    subject,
    section: section._id,
    createdBy: req.user._id, // server-derived — never client input
    status: 'published',
  });
  await audit(req, 'assignment.create', {
    entityType: 'assignment', entityId: doc._id, section: doc.section,
    after: { title: doc.title, subject: String(subject), deadline: doc.deadline.toISOString() },
  });
  await notifyAssignmentCreated(req, doc); // updates/archives never re-notify
  // suppressGroupBroadcast: CR portal uploads files after create, then fires the combined broadcast once.
  if (req.body?.suppressGroupBroadcast !== true) {
  await broadcastToSectionGroup(doc.section, await assignmentMessage(doc, subject), doc.attachments); // WhatsApp class-group (best-effort)
  }
  return doc;
}

function assignmentFilters(query, { forceSection }) {
  const filter = {};
  if (forceSection) filter.section = forceSection;
  const sectionParam = query.sectionId ?? query.section;
  if (sectionParam) filter.section = v.assertObjectId(sectionParam, 'section id');
  if (query.subjectId) filter.subject = v.assertObjectId(query.subjectId, 'subject id');
  if (query.status) filter.status = v.assertEnum(query.status, ['published', 'archived'], 'status');
  const search = searchFilter(query.search, ['title', 'instructions']);
  if (search) Object.assign(filter, search);
  return filter;
}

async function listAssignments(filter, query) {
  const { page, limit, skip } = parsePagination(query);
  const [items, total] = await Promise.all([
    Assignment.find(filter).populate('subject', 'name code').populate('createdBy', 'name')
      .sort({ createdAt: -1 }).skip(skip).limit(limit),
    Assignment.countDocuments(filter),
  ]);
  return { items: items.map(withDeadlineState), pagination: paginationMeta(total, { page, limit }) };
}

export async function listAssignmentsAdmin(req) {
  return listAssignments(assignmentFilters(req.query, {}), req.query);
}

export async function listAssignmentsCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  return listAssignments(assignmentFilters(req.query, { forceSection: req.user.section }), req.query);
}

export async function listAssignmentsStudent(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  // sectionId from a student is never read — always server-derived
  const result = await listAssignments(assignmentFilters({ ...req.query, sectionId: undefined, section: undefined },
    { forceSection: req.user.section }), req.query);
  // Embed the requesting student's OWN submission state per assignment so the
  // portal list can show Submitted / Pending without an N+1 of client calls.
  const subs = await Submission.find({ student: req.user._id })
    .where('assignment').in(result.items.map((a) => a._id))
    .select('assignment submittedAt isLate updatedAt');
  const byAssignment = new Map(subs.map((s) => [String(s.assignment), {
    _id: s._id, submittedAt: s.submittedAt, isLate: s.isLate, updatedAt: s.updatedAt,
  }]));
  result.items = result.items.map((a) => ({ ...a, mySubmission: byAssignment.get(String(a._id)) ?? null }));
  return result;
}

export async function getAssignmentAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'assignment id');
  const doc = await Assignment.findById(id).populate('subject', 'name code').populate('createdBy', 'name');
  if (!doc) throw new ApiError(404, 'Assignment not found');
  return withDeadlineState(doc);
}

async function findOwnAssignment(req) {
  const id = v.assertObjectId(req.params.id ?? req.params.assignmentId, 'assignment id');
  const doc = await Assignment.findOne({ _id: id, section: req.user.section });
  if (!doc) throw new ApiError(404, 'Assignment not found'); // cross-section = missing
  return doc;
}

export async function getAssignmentCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const doc = await findOwnAssignment(req);
  await doc.populate('subject', 'name code');
  await doc.populate('createdBy', 'name');
  return withDeadlineState(doc);
}

export async function getAssignmentStudent(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const doc = await findOwnAssignment(req);
  await doc.populate('subject', 'name code');
  await doc.populate('createdBy', 'name');
  return withDeadlineState(doc);
}

async function applyAssignmentUpdate(req, doc, { scoped }) {
  const body = v.pick(req.body, ['title', 'instructions', 'deadline', 'subject']);
  const sectionId = scoped ? req.user.section : doc.section;
  const fields = {};
  if (body.title !== undefined) fields.title = assertTitle(body.title);
  if (body.instructions !== undefined) fields.instructions = assertInstructions(body.instructions);
  if (body.deadline !== undefined) fields.deadline = assertDeadline(body.deadline);
  if (body.subject !== undefined) fields.subject = await assertSectionSubject(body.subject, sectionId);
  // section can never be moved — silently ignored even for admin
  const before = { title: doc.title, deadline: doc.deadline.toISOString() };
  Object.assign(doc, fields);
  await doc.save();
  await audit(req, 'assignment.update', {
    entityType: 'assignment', entityId: doc._id, section: doc.section,
    before, after: { title: doc.title, deadline: doc.deadline.toISOString() },
  });
  return doc;
}

export async function updateAssignmentAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'assignment id');
  const doc = await Assignment.findById(id);
  if (!doc) throw new ApiError(404, 'Assignment not found');
  if (doc.status === 'archived') throw new ApiError(400, 'Archived assignment cannot be modified');
  return applyAssignmentUpdate(req, doc, { scoped: false });
}

export async function updateAssignmentCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const doc = await findOwnAssignment(req);
  if (doc.status === 'archived') throw new ApiError(400, 'Archived assignment cannot be modified');
  return applyAssignmentUpdate(req, doc, { scoped: true });
}

async function archiveAssignment(req, doc) {
  if (doc.status === 'archived') throw new ApiError(409, 'Assignment already archived');
  doc.status = 'archived';
  await doc.save(); // title, attachments, author, section, subject, submissions all preserved
  await audit(req, 'assignment.archive', {
    entityType: 'assignment', entityId: doc._id, section: doc.section,
    before: { status: 'published' }, after: { status: 'archived' },
  });
  return doc;
}

export async function archiveAssignmentAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'assignment id');
  const doc = await Assignment.findById(id);
  if (!doc) throw new ApiError(404, 'Assignment not found');
  return archiveAssignment(req, doc);
}

export async function archiveAssignmentCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const doc = await findOwnAssignment(req);
  return archiveAssignment(req, doc);
}

/* -------------------------------- DELETE -------------------------------- */

/** Hard delete: destroys attachment + submission assets, removes notifications, then the doc. */
async function deleteAssignment(req, doc) {
  destroyAttachmentMetas(doc.attachments);
  const submissions = await Submission.find({ assignment: doc._id });
  for (const sub of submissions) destroyAttachmentMetas(sub.files);
  const subIds = submissions.map((sub) => sub._id);
  await Submission.deleteMany({ assignment: doc._id });
  await Notification.deleteMany({
    $or: [
      { refType: 'Assignment', refId: doc._id },
      { refType: 'Submission', refId: { $in: subIds } },
      { refId: { $in: [doc._id, ...subIds] } }, // any legacy link shape
    ],
  });
  const title = doc.title;
  await doc.deleteOne();
  await audit(req, 'assignment.delete', {
    entityType: 'assignment', entityId: doc._id, section: doc.section,
    before: { title }, after: { deleted: true, submissions: subIds.length },
  });
  return { deleted: true, id: doc._id, submissionsRemoved: subIds.length };
}

export async function deleteAssignmentAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'assignment id');
  const doc = await Assignment.findById(id);
  if (!doc) throw new ApiError(404, 'Assignment not found');
  return deleteAssignment(req, doc);
}

export async function deleteAssignmentCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const doc = await findOwnAssignment(req);
  return deleteAssignment(req, doc);
}

/* ------------------------------ SUBMISSIONS ----------------------------- */

async function assertOwnAssignment(req, { assignmentId }) {
  const id = v.assertObjectId(assignmentId, 'assignment id');
  const doc = await Assignment.findOne({ _id: id, section: req.user.section });
  if (!doc) throw new ApiError(404, 'Assignment not found'); // cross-section = missing
  return doc;
}

/**
 * Create-or-update the student's single submission for an assignment.
 * Deadline + archived checks are enforced with SERVER time before any write;
 * the write itself is an atomic upsert so races resolve to one record.
 */
export async function submitSubmission(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const assignment = await assertOwnAssignment(req, { assignmentId: req.params.assignmentId });

  if (assignment.status === 'archived') throw new ApiError(400, 'Assignment is archived — submissions are closed');
  if (now() > new Date(assignment.deadline).getTime()) {
    throw new ApiError(400, 'Deadline has passed — submissions are locked');
  }

  // `files` is deliberately NOT picked: attachment metadata reaches a
  // Submission ONLY via the verified Cloudinary confirm flow (Step 10) — a
  // client can never inject arbitrary attachment objects through this route.
  const body = v.pick(req.body, ['textAnswer', 'pendingFiles']);
  const text = assertTextAnswer(body.textAnswer);
  const filter = { assignment: assignment._id, student: req.user._id };
  const prior = await Submission.findOne(filter).select('files');
  const hasFiles = (prior?.files?.length ?? 0) > 0;
  // First submission may legitimately carry ONLY files (chosen pre-submit, they
  // upload right after this call creates the parent). The client declares how
  // many files are about to be confirmed; resubmissions rely on confirmed files.
  const pendingFiles = Number(body.pendingFiles);
  const intendsFiles = Number.isInteger(pendingFiles) && pendingFiles > 0 && pendingFiles <= 10;
  if (!text && !hasFiles && !intendsFiles) throw new ApiError(400, 'Submission requires text and/or files');

  const existedBefore = await Submission.exists(filter);
  const update = {
    $set: {
      textAnswer: text ?? null, // confirmed attachments are preserved — never replaced here
      isLate: false, // server-derived only — client can never set this
      // updatedAt handled by mongoose timestamps; submittedAt set once below
    },
    $setOnInsert: {
      assignment: assignment._id,
      student: req.user._id, // server-derived — never client input
      section: assignment.section, // denormalized, consistent with assignment
      submittedAt: nowDate(),
    },
  };

  let doc;
  try {
    doc = await Submission.findOneAndUpdate(filter, update, { upsert: true, new: true });
  } catch (err) {
    // unique-index race (two concurrent first submissions): safely update the
    // single existing record instead of erroring or duplicating.
    if (err?.code === 11000) {
      doc = await Submission.findOneAndUpdate(filter, update, { new: true });
    } else {
      throw err;
    }
  }

  await audit(req, existedBefore ? 'submission.update' : 'submission.create', {
    entityType: 'submission', entityId: doc._id, section: doc.section,
    // NEVER copy submission content into the audit log — ids and counts only
    after: {
      assignment: String(assignment._id), student: String(req.user._id),
      files: hasFiles ? prior.files.length : 0, hadText: Boolean(text),
    },
  });
  return doc;
}

function assertTextAnswer(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > TEXT_MAX) throw new ApiError(400, `Text must be at most ${TEXT_MAX} characters`);
  return text;
}

export async function getMySubmission(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const assignment = await assertOwnAssignment(req, { assignmentId: req.params.assignmentId });
  // only ever the authenticated student's own record — ids are never read from input
  const doc = await Submission.findOne({ assignment: assignment._id, student: req.user._id })
    .populate('assignment', 'title deadline status');
  if (!doc) throw new ApiError(404, 'Submission not found');
  return doc;
}

async function listSubmissionsForAssignment(assignmentId, query) {
  const { page, limit, skip } = parsePagination(query);
  const filter = { assignment: assignmentId };
  const [items, total] = await Promise.all([
    Submission.find(filter).populate('student', 'name rollNo email')
      .sort({ submittedAt: -1 }).skip(skip).limit(limit),
    Submission.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(total, { page, limit }) };
}

export async function listSubmissionsAdmin(req) {
  const id = v.assertObjectId(req.params.assignmentId, 'assignment id');
  const assignment = await Assignment.findById(id);
  if (!assignment) throw new ApiError(404, 'Assignment not found');
  return listSubmissionsForAssignment(id, req.query);
}

export async function listSubmissionsCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const assignment = await assertOwnAssignment(req, { assignmentId: req.params.assignmentId });
  return listSubmissionsForAssignment(assignment._id, req.query);
}

async function findScopedSubmission(req, { forceSection }) {
  const id = v.assertObjectId(req.params.id, 'submission id');
  const filter = forceSection ? { _id: id, section: req.user.section } : { _id: id };
  const doc = await Submission.findOne(filter).populate('student', 'name rollNo email')
    .populate('assignment', 'title deadline status subject');
  if (!doc) throw new ApiError(404, 'Submission not found'); // cross-section = missing
  return doc;
}

export async function getSubmissionAdmin(req) {
  return findScopedSubmission(req, { forceSection: false });
}

export async function getSubmissionCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  return findScopedSubmission(req, { forceSection: true });
}

/** POST /api/cr/assignments/:id/broadcast — combined text+media group send. */
export function broadcastAssignmentToGroup(req) {
  return broadcastContentToGroup(req, {
    Model: Assignment,
    kind: 'assignment',
    buildMessage: (doc) => assignmentMessage(doc, doc.subject),
  });
}
