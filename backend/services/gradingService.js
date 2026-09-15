import mongoose from 'mongoose';
import { Assessment, Mark, Section, Subject, User, Notification } from '../models/index.js';
import { ASSESSMENT_TYPES } from '../models/Assessment.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import * as v from '../utils/validators.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import { nowDate } from '../utils/clock.js';

/**
 * Grading / Marks (Step 11).
 *
 * Assessment = definition (section+subject+totalMarks+type+date).
 * Mark = one student's obtained marks for one assessment.
 *
 * SECURITY INVARIANTS
 *  - Section ownership is ALWAYS derived: CR from req.user.section, Admin
 *    from a validated body.section, Students from their own section. Client
 *    `status`/`createdBy`/`enteredBy`/`finalizedAt`/`finalizedBy` are never
 *    read — every state transition has its own endpoint.
 *  - subject.section === assessment.section, both ACTIVE at creation.
 *  - Marks only for ACTIVE students CURRENTLY in the assessment's section;
 *    pending/suspended/CR/admin accounts are rejected.
 *  - No GPA/CGPA/weighted totals — weightage is stored informationally.
 *  - Historical marks survive student rollover and subject/section archival.
 *  - Finalization is atomic (assessment lock + all marks locked in one
 *    transaction) and there is NO reopen endpoint.
 */

/** Runs fn inside a MongoDB transaction with automatic rollback on any throw. */
async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------ validation ------------------------------ */

function assertMarksValue(value, totalMarks) {
  // typeof check FIRST — strings pretending to be numbers are rejected even
  // though mongoose would happily cast them.
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ApiError(400, 'marksObtained must be a whole number');
  }
  if (value < 0) throw new ApiError(400, 'marksObtained cannot be negative');
  if (value > totalMarks) throw new ApiError(400, `marksObtained cannot exceed totalMarks (${totalMarks})`);
  return value;
}

function normalizeType(value) {
  const type = String(value ?? '').trim().toLowerCase();
  return v.assertEnum(type, ASSESSMENT_TYPES, 'type');
}

function assertWeightage(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const w = value;
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || w > 100 ||
      Math.round(w * 100) !== w * 100) {
    throw new ApiError(400, 'weightage must be a number between 0 and 100 (max 2 decimals)');
  }
  return w;
}

/** section + subject relationship — both must be ACTIVE and belong together. */
async function assertSectionSubject(sectionId, subjectId, field = 'subject') {
  const section = await Section.findById(sectionId);
  if (!section) throw new ApiError(400, 'Section not found');
  if (section.status !== 'active') throw new ApiError(400, 'Section is archived');

  const id = v.assertObjectId(subjectId, field);
  const subject = await Subject.findById(id);
  if (!subject) throw new ApiError(400, 'Subject not found');
  if (String(subject.section) !== String(section._id)) {
    throw new ApiError(400, 'Subject does not belong to this section');
  }
  if (subject.status !== 'active') throw new ApiError(400, 'Subject is archived');
  return { section, subject };
}

/**
 * Eligible mark recipient: an ACTIVE student CURRENTLY in the assessment's
 * section. Pending/suspended users, CRs and admins are never markable, and a
 * student who rolled to another section cannot receive marks here anymore.
 */
async function assertEligibleStudent(studentId, sectionId) {
  const id = v.assertObjectId(studentId, 'student id');
  const user = await User.findById(id);
  if (!user || user.role !== 'student') throw new ApiError(400, 'Invalid student');
  if (user.registrationStatus !== 'active') {
    throw new ApiError(400, `Student is ${user.registrationStatus}`);
  }
  if (String(user.section ?? '') !== String(sectionId)) {
    throw new ApiError(400, 'Student does not belong to this section');
  }
  return id;
}

/* ------------------------------- responses ------------------------------ */

function safeAssessment(doc, extra = {}) {
  return {
    _id: doc._id,
    section: doc.section,
    subject: doc.subject,
    title: doc.title,
    type: doc.type,
    totalMarks: doc.totalMarks,
    assessmentDate: doc.assessmentDate,
    weightage: doc.weightage,
    status: doc.status,
    createdBy: doc.createdBy,
    finalizedAt: doc.finalizedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...extra, // e.g. enteredCount / myMark
  };
}

function safeMark(doc) {
  return {
    _id: doc._id,
    assessment: doc.assessment,
    section: doc.section,
    subject: doc.subject,
    student: doc.student,
    marksObtained: doc.marksObtained,
    status: doc.status,
    enteredBy: doc.enteredBy,
    finalizedAt: doc.finalizedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/* ------------------------------ load helpers ---------------------------- */

/** Loads an assessment scoped to a section (CR/Student isolation → 404). */
async function findScopedAssessment(id, sectionId) {
  const aid = v.assertObjectId(id, 'assessment id');
  const doc = sectionId
    ? await Assessment.findOne({ _id: aid, section: sectionId }).populate('subject', 'name code status')
    : await Assessment.findById(aid).populate('subject', 'name code status');
  if (!doc) throw new ApiError(404, 'Assessment not found'); // cross-section = missing
  return doc;
}

function assertNotFinalizedOrArchived(doc) {
  if (doc.status === 'finalized') throw new ApiError(400, 'Assessment is finalized — it can no longer be modified');
  if (doc.status === 'archived') throw new ApiError(400, 'Assessment is archived — it is read-only');
}

/* --------------------------- assessment CRUD ---------------------------- */

export async function createAssessment(req) {
  // CR: section ALWAYS server-derived; Admin: explicit but validated.
  let sectionId;
  if (req.user.role === 'admin') {
    sectionId = v.assertObjectId(req.body?.section, 'section');
  } else {
    if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
    sectionId = req.user.section;
  }

  const body = v.pick(req.body, ['subject', 'title', 'type', 'totalMarks', 'assessmentDate', 'weightage']);
  const { subject } = await assertSectionSubject(sectionId, body.subject);

  const title = v.assertName(body.title, 'title');
  const type = normalizeType(body.type);
  const totalMarks = body.totalMarks;
  if (typeof totalMarks !== 'number' || !Number.isInteger(totalMarks) || totalMarks < 1 || totalMarks > 1000) {
    throw new ApiError(400, 'totalMarks must be a whole number between 1 and 1000');
  }
  const assessmentDate = v.assertDate(body.assessmentDate, 'assessmentDate');
  const weightage = assertWeightage(body.weightage);

  const doc = await Assessment.create({
    section: sectionId, // immutable from here on
    subject: subject._id,
    title,
    type,
    totalMarks,
    assessmentDate,
    ...(weightage !== undefined ? { weightage } : {}),
    status: 'draft', // server-controlled lifecycle
    createdBy: req.user._id, // server-derived
  });

  await auditFromReq(req, {
    action: 'assessment.create', entityType: 'assessment', entityId: doc._id, section: doc.section,
    after: { title: doc.title, type: doc.type, subject: String(subject._id), totalMarks: doc.totalMarks },
  });

  return safeAssessment(doc);
}

function assessmentFilters(query, { forceSection }) {
  const filter = {};
  if (forceSection) filter.section = forceSection;
  else if (query.sectionId ?? query.section) filter.section = v.assertObjectId(query.sectionId ?? query.section, 'section id');
  if (query.subjectId) filter.subject = v.assertObjectId(query.subjectId, 'subject id');
  if (query.status) filter.status = v.assertEnum(String(query.status), ['draft', 'open', 'finalized', 'archived'], 'status');
  if (query.type) filter.type = v.assertEnum(String(query.type).trim().toLowerCase(), ASSESSMENT_TYPES, 'type');
  return filter;
}

async function listAssessments(filter, query) {
  const { page, limit, skip } = parsePagination(query);
  const [items, total] = await Promise.all([
    Assessment.find(filter).populate('subject', 'name code status')
      .sort({ assessmentDate: -1, createdAt: -1, _id: -1 }).skip(skip).limit(limit),
    Assessment.countDocuments(filter),
  ]);
  return {
    items: items.map((a) => safeAssessment(a)),
    pagination: paginationMeta(total, { page, limit }),
  };
}

export async function listAssessmentsCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  return listAssessments(
    assessmentFilters({ ...req.query, sectionId: undefined, section: undefined }, { forceSection: req.user.section }),
    req.query
  );
}

export async function listAssessmentsAdmin(req) {
  return listAssessments(assessmentFilters(req.query, {}), req.query);
}

/** Students see their OWN section's assessments — drafts are work-in-progress and hidden. */
export async function listAssessmentsStudent(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const { items, pagination } = await listAssessments(
    { section: req.user.section, status: { $in: ['open', 'finalized', 'archived'] } },
    req.query
  );
  // Embed the student's own mark (or calculated "missing") per assessment.
  const marks = await Mark.find({
    student: req.user._id,
    assessment: { $in: items.map((a) => a._id) },
  });
  const byAssessment = new Map(marks.map((m) => [String(m.assessment), m]));
  return {
    items: items.map((a) => ({ ...a, myMark: byAssessment.has(String(a._id)) ? safeMark(byAssessment.get(String(a._id))) : null })),
    pagination,
  };
}

export async function getAssessmentCr(req) {
  const doc = await findScopedAssessment(req.params.id, req.user.section);
  return safeAssessment(doc, { enteredCount: await Mark.countDocuments({ assessment: doc._id }) });
}

export async function getAssessmentAdmin(req) {
  const doc = await findScopedAssessment(req.params.id, null);
  return safeAssessment(doc, { enteredCount: await Mark.countDocuments({ assessment: doc._id }) });
}

export async function getAssessmentStudent(req) {
  const doc = await findScopedAssessment(req.params.id, req.user.section);
  if (doc.status === 'draft') throw new ApiError(404, 'Assessment not found'); // not published yet
  const myMark = await Mark.findOne({ assessment: doc._id, student: req.user._id });
  return safeAssessment(doc, { myMark: myMark ? safeMark(myMark) : null, myStatus: myMark ? 'entered' : 'missing' });
}

/* ------------------------------ lifecycle ------------------------------- */

/** draft → open. Explicit endpoint — status is never taken from the client. */
export async function openAssessment(req) {
  const scopeSection = req.user.role !== 'admin';
  const doc = await findScopedAssessment(req.params.id, scopeSection ? req.user.section : null);
  const updated = await Assessment.findOneAndUpdate(
    { _id: doc._id, status: 'draft' },
    { $set: { status: 'open' } },
    { new: true }
  );
  if (!updated) {
    if (doc.status === 'archived') throw new ApiError(400, 'Assessment is archived');
    throw new ApiError(409, `Assessment is already ${doc.status}`); // open/finalized — race-safe
  }
  await auditFromReq(req, {
    action: 'assessment.update', entityType: 'assessment', entityId: doc._id, section: doc.section,
    before: { status: 'draft' }, after: { status: 'open' }, reason: 'opened_for_marks',
  });
  return safeAssessment(updated);
}

export async function updateAssessment(req) {
  const scopeSection = req.user.role !== 'admin';
  const doc = await findScopedAssessment(req.params.id, scopeSection ? req.user.section : null);
  assertNotFinalizedOrArchived(doc); // finalized/archived = immutable

  // NOTE: `section` is intentionally NOT patchable — Mark records denormalize
  // it; moving an assessment would corrupt historical marks.
  const body = v.pick(req.body, ['subject', 'title', 'type', 'totalMarks', 'assessmentDate', 'weightage']);
  const changes = {};

  if (body.subject !== undefined && String(body.subject) !== String(doc.subject._id ?? doc.subject)) {
    const { subject } = await assertSectionSubject(doc.section, body.subject); // same section, active
    changes.subject = subject._id;
  }
  if (body.title !== undefined) changes.title = v.assertName(body.title, 'title');
  if (body.type !== undefined) changes.type = normalizeType(body.type);
  if (body.totalMarks !== undefined) {
    const total = body.totalMarks;
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 1 || total > 1000) {
      throw new ApiError(400, 'totalMarks must be a whole number between 1 and 1000');
    }
    // lowering totalMarks below an existing mark would invalidate history
    if (total !== doc.totalMarks) {
      const highest = await Mark.findOne({ assessment: doc._id }).sort({ marksObtained: -1 });
      if (highest && highest.marksObtained > total) {
        throw new ApiError(400, `totalMarks cannot be below an already-entered mark (${highest.marksObtained})`);
      }
    }
    changes.totalMarks = total;
  }
  if (body.assessmentDate !== undefined) changes.assessmentDate = v.assertDate(body.assessmentDate, 'assessmentDate');
  if (body.weightage !== undefined) {
    const w = assertWeightage(body.weightage);
    if (w !== undefined) changes.weightage = w;
  }

  const updated = await Assessment.findOneAndUpdate(
    { _id: doc._id, status: { $in: ['draft', 'open'] } }, // finalization must win races
    { $set: changes },
    { new: true }
  );
  if (!updated) throw new ApiError(400, 'Assessment is finalized — it can no longer be modified');

  await auditFromReq(req, {
    action: 'assessment.update', entityType: 'assessment', entityId: doc._id, section: doc.section,
    before: { title: doc.title, totalMarks: doc.totalMarks, status: doc.status },
    after: { title: updated.title, totalMarks: updated.totalMarks, fields: Object.keys(changes) },
  });
  return safeAssessment(updated);
}

/**
 * Finalize: atomic lock of the assessment AND all its marks in one
 * transaction. finalizedAt/finalizedBy are server-derived. No reopen route.
 */
export async function finalizeAssessment(req) {
  const scopeSection = req.user.role !== 'admin';
  const doc = await findScopedAssessment(req.params.id, scopeSection ? req.user.section : null);

  const locked = await withTransaction(async (tx) => {
    // conditional flip — a concurrent finalize loses harmlessly (409)
    const updated = await Assessment.findOneAndUpdate(
      { _id: doc._id, status: { $in: ['draft', 'open'] } },
      { $set: { status: 'finalized', finalizedAt: nowDate(), finalizedBy: req.user._id } },
      { new: true, session: tx }
    );
    if (!updated) return { updated: null, lockedMarks: 0 };
    const res = await Mark.updateMany(
      { assessment: doc._id },
      { $set: { status: 'finalized', finalizedAt: updated.finalizedAt } },
      { session: tx }
    );
    return { updated, lockedMarks: res.modifiedCount };
  });

  if (!locked.updated) {
    if (doc.status === 'archived') throw new ApiError(400, 'Assessment is archived');
    throw new ApiError(409, `Assessment is already ${doc.status}`);
  }

  await auditFromReq(req, {
    action: 'assessment.finalize', entityType: 'assessment', entityId: doc._id, section: doc.section,
    before: { status: doc.status }, after: { status: 'finalized', lockedMarks: locked.lockedMarks },
  });
  if (locked.lockedMarks > 0) {
    await auditFromReq(req, {
      action: 'mark.finalize', entityType: 'assessment', entityId: doc._id, section: doc.section,
      after: { lockedMarks: locked.lockedMarks }, // aggregate only — no per-student payloads
    });
  }
  return safeAssessment(locked.updated, { lockedMarks: locked.lockedMarks });
}

/** Hard delete an assessment together with its marks and notifications. */
export async function deleteAssessment(req) {
  const scopeSection = req.user.role !== 'admin';
  const doc = await findScopedAssessment(req.params.id, scopeSection ? req.user.section : null);
  await Mark.deleteMany({ assessment: doc._id });
  await Notification.deleteMany({ refType: 'Assessment', refId: doc._id });
  await doc.deleteOne();
  await auditFromReq(req, {
    action: 'assessment.delete', entityType: 'assessment', entityId: doc._id, section: doc.section,
    before: { title: doc.title, status: doc.status }, after: { deleted: true },
  });
  return { deleted: true, id: doc._id };
}

export async function archiveAssessment(req) {
  const scopeSection = req.user.role !== 'admin';
  const doc = await findScopedAssessment(req.params.id, scopeSection ? req.user.section : null);
  const updated = await Assessment.findOneAndUpdate(
    { _id: doc._id, status: { $in: ['draft', 'open', 'finalized'] } },
    { $set: { status: 'archived' } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'Assessment is already archived');
  await auditFromReq(req, {
    action: 'assessment.archive', entityType: 'assessment', entityId: doc._id, section: doc.section,
    before: { status: doc.status }, after: { status: 'archived' },
  });
  return safeAssessment(updated);
}

/* -------------------------------- marks --------------------------------- */

/** Marks can be entered/updated ONLY while the assessment is open. */
function assertOpen(doc) {
  if (doc.status === 'draft') throw new ApiError(400, 'Assessment is not open for marks yet');
  if (doc.status === 'finalized') throw new ApiError(400, 'Assessment is finalized — marks are locked');
  if (doc.status === 'archived') throw new ApiError(400, 'Assessment is archived — marks are locked');
}

/** Duplicate-key races map to a SAFE 409 — the unique index is the arbiter. */
function isDuplicateKeyError(err) {
  return err?.code === 11000 || err?.message?.includes('E11000');
}

/**
 * Snapshot-isolation guard (write-skew compensation): a transaction that
 * inserts marks can commit on a snapshot taken BEFORE a concurrent finalize,
 * so its marks may land AFTER finalize's updateMany. Re-reading the
 * assessment AFTER commit and locking any late 'active' marks closes the
 * window — the invariant "finalized assessment ⇒ all marks finalized" holds.
 */
async function compensateLateMarks(assessmentId) {
  const asg = await Assessment.findById(assessmentId);
  if (!asg || asg.status === 'open' || asg.status === 'draft') return;
  if (asg.status === 'finalized' || asg.status === 'archived') {
    await Mark.updateMany(
      { assessment: assessmentId, status: 'active' },
      { $set: { status: 'finalized', finalizedAt: asg.finalizedAt ?? asg.updatedAt } }
    );
  }
}

async function loadScopedForMarks(req) {
  const scopeSection = req.user.role !== 'admin';
  const doc = await findScopedAssessment(req.params.assessmentId, scopeSection ? req.user.section : null);
  assertOpen(doc);
  return doc;
}

export async function createMark(req) {
  const doc = await loadScopedForMarks(req);
  const body = v.pick(req.body, ['student', 'marksObtained']); // section/enteredBy never read
  const student = await assertEligibleStudent(body.student, doc.section);
  const marksObtained = assertMarksValue(body.marksObtained, doc.totalMarks);

  try {
    // Transaction + in-tx status re-check: a mark can NEVER slip past a
    // concurrent finalize — the write aborts if the assessment left 'open'.
    const mark = await withTransaction(async (tx) => {
      const still = await Assessment.findOne({ _id: doc._id, status: 'open' }, { _id: 1 }, { session: tx });
      if (!still) throw new ApiError(400, 'Assessment is finalized — marks are locked');
      return Mark.create([{
        assessment: doc._id,
        section: doc.section,     // denormalized history — immutable
        subject: doc.subject._id ?? doc.subject,
        student,
        marksObtained,
        status: 'active',
        enteredBy: req.user._id,   // server-derived
      }], { session: tx }).then((r) => r[0]);
    });
    await compensateLateMarks(doc._id);
    await auditFromReq(req, {
      action: 'mark.create', entityType: 'mark', entityId: mark._id, section: doc.section,
      after: { assessment: String(doc._id), student: String(student), marksObtained },
    });
    const fresh = await Mark.findById(mark._id);
    return safeMark(fresh ?? mark);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new ApiError(409, 'Mark already exists for this student — use PATCH to update it');
    }
    throw err;
  }
}

export async function updateMark(req) {
  const doc = await loadScopedForMarks(req);
  const student = v.assertObjectId(req.params.studentId, 'student id');
  const body = v.pick(req.body, ['marksObtained']);
  const marksObtained = assertMarksValue(body.marksObtained, doc.totalMarks);

  const prior = await Mark.findOne({ assessment: doc._id, student });
  if (!prior) throw new ApiError(404, 'Mark not found'); // never entered / cross-user = missing
  if (prior.status !== 'active') throw new ApiError(400, 'Mark is finalized — it cannot be updated');
  const updated = await withTransaction(async (tx) => {
    // re-check the lock INSIDE the transaction — a concurrent finalize aborts us
    const still = await Assessment.findOne({ _id: doc._id, status: 'open' }, { _id: 1 }, { session: tx });
    if (!still) throw new ApiError(400, 'Assessment is finalized — marks are locked');
    return Mark.findOneAndUpdate(
      { assessment: doc._id, student, status: 'active', _id: prior._id },
      { $set: { marksObtained, enteredBy: req.user._id } },
      { new: true, session: tx }
    );
  });
  if (!updated) throw new ApiError(400, 'Mark is finalized — it cannot be updated'); // lost a finalize race
  await auditFromReq(req, {
    action: 'mark.update', entityType: 'mark', entityId: updated._id, section: doc.section,
    before: { marksObtained: prior.marksObtained },
    after: { assessment: String(doc._id), student: String(student), marksObtained },
  });
  return safeMark(updated);
}

/**
 * Bulk upsert — validates EVERY row before writing anything, then applies all
 * rows inside ONE transaction: no partial writes on any failure.
 * Duplicate student rows within the payload are rejected up front.
 */
export async function bulkUpsertMarks(req) {
  const doc = await loadScopedForMarks(req);
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows must be a non-empty array');
  if (rows.length > 500) throw new ApiError(400, 'Too many rows (max 500)');

  // validate every row first — collect errors, write nothing until all pass
  const seen = new Set();
  const validated = [];
  const errors = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? {};
    try {
      const student = await assertEligibleStudent(row.student, doc.section);
      if (seen.has(String(student))) throw new ApiError(400, `Duplicate student in rows (row ${i})`);
      seen.add(String(student));
      validated.push({ student, marksObtained: assertMarksValue(row.marksObtained, doc.totalMarks) });
    } catch (err) {
      errors.push(`row ${i}: ${err.message}`);
    }
  }
  if (errors.length) throw new ApiError(400, `Invalid rows — nothing was written: ${errors.slice(0, 5).join('; ')}`);

  const subjectId = doc.subject._id ?? doc.subject;
  const result = await withTransaction(async (tx) => {
    // the conditional re-check inside the transaction makes a concurrent
    // finalize atomic against the bulk write (the transaction aborts)
    const still = await Assessment.findOne({ _id: doc._id, status: 'open' }, { _id: 1 }, { session: tx });
    if (!still) throw new ApiError(400, 'Assessment is finalized — marks are locked');

    const ops = validated.map((r) => ({
      updateOne: {
        filter: { assessment: doc._id, student: r.student },
        update: {
          $set: { marksObtained: r.marksObtained, enteredBy: req.user._id },
          $setOnInsert: {
            assessment: doc._id, section: doc.section, subject: subjectId,
            student: r.student, status: 'active',
          },
        },
        upsert: true,
      },
    }));
    // Re-check the lock, then bulkWrite — unique index still guards races.
    return Mark.bulkWrite(ops, { session: tx, ordered: false });
  });

  await compensateLateMarks(doc._id);
  await auditFromReq(req, {
    action: 'mark.bulk_create', entityType: 'assessment', entityId: doc._id, section: doc.section,
    after: { rows: validated.length, created: result.upsertedCount, updated: result.modifiedCount },
  });
  return {
    processed: validated.length, created: result.upsertedCount, updated: result.modifiedCount,
    assessment: doc._id,
  };
}

/**
 * CR/Admin marks sheet for an assessment: entered marks + the calculated
 * MISSING list (active section students with no Mark document — never
 * backfilled with zeros, never stored).
 */
export async function listMarks(req) {
  const scopeSection = req.user.role !== 'admin';
  const doc = await findScopedAssessment(req.params.assessmentId, scopeSection ? req.user.section : null);

  const [marks, students, totalStudents] = await Promise.all([
    Mark.find({ assessment: doc._id }).populate('student', 'name rollNo email'),
    User.find({ section: doc.section, role: 'student', registrationStatus: 'active' })
      .select('name rollNo email').sort({ rollNo: 1, name: 1 }),
    User.countDocuments({ section: doc.section, role: 'student', registrationStatus: 'active' }),
  ]);
  const marked = new Set(marks.map((m) => String(m.student?._id ?? m.student)));
  const missing = students.filter((s) => !marked.has(String(s._id)));

  return {
    assessment: safeAssessment(doc, { enteredCount: marks.length }),
    items: marks.map(safeMark),
    missing,
    counts: { activeStudents: totalStudents, entered: marks.length, missing: missing.length },
  };
}

/* ------------------------------ student views --------------------------- */

/** The student's ENTIRE own-marks history (all sections, incl. rollover). */
export async function listMyMarks(req) {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { student: req.user._id }; // own records only — nothing else is readable
  const [items, total] = await Promise.all([
    Mark.find(filter)
      .populate('assessment', 'title type totalMarks status assessmentDate')
      .populate('subject', 'name code')
      .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
    Mark.countDocuments(filter),
  ]);
  return {
    items: items.map((m) => ({ ...safeMark(m) })),
    pagination: paginationMeta(total, { page, limit }),
  };
}
