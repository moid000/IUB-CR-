import mongoose from 'mongoose';
import {
  Department, AcademicSession, Section, User, Subject, Announcement, Note,
  Assignment, Timetable, Assessment, Submission, Mark, Notification, AttendanceSession,
  AttendanceRecord, Otp,
} from '../models/index.js';
import { destroyAttachmentMetas } from './fileService.js';
import { parsePagination, paginationMeta, searchFilter } from '../utils/pagination.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import * as v from '../utils/validators.js';

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

/* ============================== Departments ============================== */

export async function createDepartment(req) {
  const body = v.pick(req.body, ['name', 'code']);
  const name = v.assertName(body.name, 'name');
  const code = String(body.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,12}$/.test(code)) throw new ApiError(400, 'Invalid code (2–12 letters/digits)');

  const doc = await Department.create({ name, code });
  await auditFromReq(req, {
    action: 'department.create', entityType: 'department', entityId: doc._id,
    after: { name, code },
  });
  return doc;
}

export async function listDepartments(req) {
  const filter = {};
  if (req.query.status) filter.status = v.assertEnum(req.query.status, ['active', 'archived'], 'status');
  return Department.find(filter).sort({ name: 1 });
}

export async function getDepartment(req) {
  const id = v.assertObjectId(req.params.id, 'department id');
  const doc = await Department.findById(id);
  if (!doc) throw new ApiError(404, 'Department not found');
  return doc;
}

export async function updateDepartment(req) {
  const id = v.assertObjectId(req.params.id, 'department id');
  const doc = await Department.findById(id);
  if (!doc) throw new ApiError(404, 'Department not found');

  const body = v.pick(req.body, ['name', 'code']);
  const before = { name: doc.name, code: doc.code };
  if (body.name !== undefined) doc.name = v.assertName(body.name, 'name');
  if (body.code !== undefined) {
    const code = String(body.code).trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,12}$/.test(code)) throw new ApiError(400, 'Invalid code (2–12 letters/digits)');
    doc.code = code;
  }
  await doc.save(); // duplicate → 11000 → 409 via error handler
  await auditFromReq(req, {
    action: 'department.update', entityType: 'department', entityId: doc._id,
    before, after: { name: doc.name, code: doc.code },
  });
  return doc;
}

export async function archiveDepartment(req) {
  const id = v.assertObjectId(req.params.id, 'department id');
  const doc = await Department.findById(id);
  if (!doc) throw new ApiError(404, 'Department not found');
  if (doc.status === 'archived') throw new ApiError(409, 'Department already archived');

  const activeSections = await Section.countDocuments({ department: id, status: 'active' });
  if (activeSections > 0) {
    throw new ApiError(400, 'Cannot archive: department still has active sections');
  }

  doc.status = 'archived';
  await doc.save();
  await auditFromReq(req, {
    action: 'department.archive', entityType: 'department', entityId: doc._id,
    before: { status: 'active' }, after: { status: 'archived' },
  });
  return doc;
}

/* =========================== Academic Sessions =========================== */

export async function createSession(req) {
  const body = v.pick(req.body, ['name', 'startedAt', 'endedAt', 'status']);
  const name = v.assertName(body.name, 'name');
  const startedAt = body.startedAt !== undefined ? v.assertDate(body.startedAt, 'startedAt') : undefined;
  const endedAt = body.endedAt !== undefined ? v.assertDate(body.endedAt, 'endedAt') : undefined;
  if (startedAt && endedAt && endedAt <= startedAt) {
    throw new ApiError(400, 'endedAt must be after startedAt');
  }
  const status = body.status !== undefined
    ? v.assertEnum(body.status, ['active', 'archived'], 'status')
    : 'active';

  // Clean pre-check (DB partial unique index remains the backstop)
  if (status === 'active') {
    const activeExists = await AcademicSession.exists({ status: 'active' });
    if (activeExists) throw new ApiError(409, 'Another academic session is already active');
  }

  const doc = await AcademicSession.create({ name, startedAt, endedAt, status });
  await auditFromReq(req, {
    action: 'session.create', entityType: 'session', entityId: doc._id,
    after: { name, status },
  });
  return doc;
}

export async function listSessions(req) {
  const filter = {};
  if (req.query.status) filter.status = v.assertEnum(req.query.status, ['active', 'archived'], 'status');
  return AcademicSession.find(filter).sort({ createdAt: -1 });
}

export async function getSession(req) {
  const id = v.assertObjectId(req.params.id, 'session id');
  const doc = await AcademicSession.findById(id);
  if (!doc) throw new ApiError(404, 'Session not found');
  return doc;
}

export async function updateSession(req) {
  const id = v.assertObjectId(req.params.id, 'session id');
  const doc = await AcademicSession.findById(id);
  if (!doc) throw new ApiError(404, 'Session not found');

  const body = v.pick(req.body, ['name', 'startedAt', 'endedAt', 'status']);
  const before = { name: doc.name, status: doc.status };
  if (body.name !== undefined) doc.name = v.assertName(body.name, 'name');
  if (body.startedAt !== undefined) doc.startedAt = v.assertDate(body.startedAt, 'startedAt');
  if (body.endedAt !== undefined) doc.endedAt = v.assertDate(body.endedAt, 'endedAt');
  if (body.status !== undefined) {
    doc.status = v.assertEnum(body.status, ['active', 'archived'], 'status');
    if (doc.status === 'active') {
      const otherActive = await AcademicSession.countDocuments({ status: 'active', _id: { $ne: doc._id } });
      if (otherActive > 0) throw new ApiError(409, 'Another academic session is already active');
    }
  }
  if (doc.startedAt && doc.endedAt && doc.endedAt <= doc.startedAt) {
    throw new ApiError(400, 'endedAt must be after startedAt');
  }
  await doc.save();
  await auditFromReq(req, {
    action: 'session.update', entityType: 'session', entityId: doc._id,
    before, after: { name: doc.name, status: doc.status },
  });
  return doc;
}

export async function archiveSession(req) {
  const id = v.assertObjectId(req.params.id, 'session id');
  const doc = await AcademicSession.findById(id);
  if (!doc) throw new ApiError(404, 'Session not found');
  if (doc.status === 'archived') throw new ApiError(409, 'Session already archived');
  doc.status = 'archived';
  await doc.save();
  await auditFromReq(req, {
    action: 'session.archive', entityType: 'session', entityId: doc._id,
    before: { status: 'active' }, after: { status: 'archived' },
  });
  return doc;
}

/* =============================== Sections ================================ */

const SECTION_NAME_RE = /^[A-Z0-9-]{1,16}$/;

async function resolveSectionContext(body) {
  const department = v.assertObjectId(body.department, 'department id');
  const session = v.assertObjectId(body.session, 'session id');
  const semester = v.assertSemester(body.semester);
  const name = String(body.name ?? body.sectionName ?? '').trim().toUpperCase();
  if (!SECTION_NAME_RE.test(name)) throw new ApiError(400, 'Invalid section name');

  const dept = await Department.findById(department);
  if (!dept) throw new ApiError(400, 'Department not found');
  if (dept.status !== 'active') throw new ApiError(400, 'Department is archived');
  const sess = await AcademicSession.findById(session);
  if (!sess) throw new ApiError(400, 'Session not found');
  if (sess.status !== 'active') throw new ApiError(400, 'Session is archived');

  return { department, session, semester, name };
}

export async function createSection(req) {
  const body = v.pick(req.body, ['department', 'session', 'semester', 'name', 'cr']);
  const ctx = await resolveSectionContext(body);

  // Optional CR assignment during creation — validated BEFORE the transaction
  let crUser = null;
  if (body.cr !== undefined && body.cr !== null && body.cr !== '') {
    const crId = v.assertObjectId(body.cr, 'cr id');
    crUser = await User.findById(crId);
    if (!crUser) throw new ApiError(400, 'CR user not found');
    if (crUser.role !== 'cr') throw new ApiError(400, 'User is not a CR');
    if (crUser.section) throw new ApiError(409, 'CR already belongs to another section');
  }

  // Section.cr and User.section are always mutated together, inside ONE transaction
  const section = await withTransaction(async (tx) => {
    const [doc] = await Section.create([{ ...ctx, status: 'active' }], { session: tx });
    if (crUser) {
      doc.cr = crUser._id;
      await doc.save({ session: tx });
      crUser.section = doc._id;
      await crUser.save({ session: tx });
    }
    return doc;
  });

  await auditFromReq(req, {
    action: 'section.create', entityType: 'section', entityId: section._id,
    section: section._id,
    after: { ...ctx, cr: crUser ? String(crUser._id) : null },
  });
  return section;
}

export async function listSections(req) {
  const filter = {};
  if (req.query.department) filter.department = v.assertObjectId(req.query.department, 'department id');
  if (req.query.session) filter.session = v.assertObjectId(req.query.session, 'session id');
  if (req.query.status) filter.status = v.assertEnum(req.query.status, ['active', 'archived'], 'status');
  return Section.find(filter)
    .populate('department', 'name code')
    .populate('session', 'name status')
    .populate('cr', 'name email')
    .sort({ createdAt: -1 });
}

export async function getSection(req) {
  const id = v.assertObjectId(req.params.id, 'section id');
  const doc = await Section.findById(id)
    .populate('department', 'name code')
    .populate('session', 'name status')
    .populate('cr', 'name email');
  if (!doc) throw new ApiError(404, 'Section not found');
  return doc;
}

/**
 * Updates ONLY allowed administrative fields (name, semester).
 * Protected fields (department, session, cr, status, pastMembers) can NEVER
 * be set from a client payload — pastMembers is exclusively admin-promotion
 * logic territory and has no update path at all in this phase.
 */
export async function updateSection(req) {
  const id = v.assertObjectId(req.params.id, 'section id');
  const doc = await Section.findById(id);
  if (!doc) throw new ApiError(404, 'Section not found');

  const body = v.pick(req.body, ['name', 'semester']);
  const before = { name: doc.name, semester: doc.semester };
  if (body.name !== undefined) {
    const name = String(body.name).trim().toUpperCase();
    if (!SECTION_NAME_RE.test(name)) throw new ApiError(400, 'Invalid section name');
    doc.name = name;
  }
  if (body.semester !== undefined) doc.semester = v.assertSemester(body.semester);
  await doc.save(); // duplicate → 11000 → 409 via error handler
  await auditFromReq(req, {
    action: 'section.update', entityType: 'section', entityId: doc._id, section: doc._id,
    before, after: { name: doc.name, semester: doc.semester },
  });
  return doc;
}

/**
 * Archiving a Section never deletes or modifies ANY historical content
 * (subjects, assignments, submissions, attendance, timetable, audit logs).
 * If the section has an active CR, both sides are cleared transactionally —
 * the CR becomes sectionless but their account is NOT archived or modified
 * beyond the section link.
 */
export async function archiveSection(req) {
  const id = v.assertObjectId(req.params.id, 'section id');
  const doc = await Section.findById(id);
  if (!doc) throw new ApiError(404, 'Section not found');
  if (doc.status === 'archived') throw new ApiError(409, 'Section already archived');

  const before = { status: doc.status, cr: doc.cr ? String(doc.cr) : null };

  if (doc.cr) {
    await withTransaction(async (tx) => {
      const cr = await User.findById(doc.cr).session(tx);
      doc.cr = null;
      doc.status = 'archived';
      await doc.save({ session: tx });
      if (cr) {
        cr.section = null; // CR becomes sectionless — account untouched otherwise
        await cr.save({ session: tx });
      }
    });
  } else {
    doc.status = 'archived';
    await doc.save();
  }

  await auditFromReq(req, {
    action: 'section.archive', entityType: 'section', entityId: doc._id, section: doc._id,
    before, after: { status: 'archived', cr: null }, reason: req.body?.reason,
  });
  return doc;
}

/* ========================== CR pre-creation =========================== */

/**
 * Admin-only CR pre-creation. Creates the CR account (pending, no password,
 * cannot log in until activation is implemented later) and, in the SAME
 * transaction, either links them to an existing section or creates the
 * section first. Section ownership is ALWAYS server-derived — the admin
 * supplies a validated sectionId or explicit department/session/semester/
 * name, and the server resolves the rest.
 *
 * Transactional invariants (1 CR → 1 Section, 1 Section → 1 CR):
 * - section already has a CR → rejected (never silently overwritten)
 * - CR already belongs to a section → rejected (no reassignment path in this phase)
 * - on any failure, ALL changes roll back
 */
export async function precreateCr(req) {
  const body = v.pick(req.body, [
    'name', 'email', 'phone', 'sectionId',
    'department', 'session', 'semester', 'sectionName',
  ]);
  const name = v.assertName(body.name, 'name');
  const email = v.assertEmail(body.email, 'email');
  const phone = v.assertPhone(body.phone, 'phone');

  if (await User.exists({ email })) throw new ApiError(409, 'Email already in use');

  let section = null;
  let ctx = null;
  if (body.sectionId) {
    const sectionId = v.assertObjectId(body.sectionId, 'section id');
    section = await Section.findById(sectionId);
    if (!section) throw new ApiError(404, 'Section not found');
    if (section.status !== 'active') throw new ApiError(400, 'Section is archived');
    if (section.cr) throw new ApiError(409, 'Section already has a CR');
  } else {
    // section name is the explicit sectionName field — never the CR's own name
    ctx = await resolveSectionContext({
      department: body.department,
      session: body.session,
      semester: body.semester,
      name: body.sectionName,
    });
  }

  const result = await withTransaction(async (tx) => {
    let target = section;
    if (!target) {
      const [created] = await Section.create([{ ...ctx, status: 'active' }], { session: tx });
      target = created;
    }
    const [cr] = await User.create([{
      name,
      email,
      phone,
      role: 'cr',
      registrationStatus: 'pending', // cannot log in until activation (later phase)
      emailVerified: false,
      password: null,
      section: target._id, // server-derived section ownership
    }], { session: tx });
    target.cr = cr._id;
    await target.save({ session: tx });
    return { cr, section: target };
  });

  await auditFromReq(req, {
    action: 'user.cr.precreate', entityType: 'user', entityId: result.cr._id,
    targetUser: result.cr._id, section: result.section._id,
    after: { name, email, role: 'cr', registrationStatus: 'pending', section: String(result.section._id) },
  });
  return result.cr;
}

/**
 * Assigns an existing CR user to a section transactionally.
 * Rejects: target section already has a CR (never silently overwritten) and
 * CRs already belonging to another section (reassignment is a SEPARATE
 * explicit admin operation — see reassignCr).
 */
export async function assignCr(req) {
  const sectionId = v.assertObjectId(req.params.id, 'section id');
  const userId = v.assertObjectId(v.pick(req.body, ['userId']).userId, 'cr user id');

  const section = await Section.findById(sectionId);
  if (!section) throw new ApiError(404, 'Section not found');
  if (section.status !== 'active') throw new ApiError(400, 'Section is archived');
  if (section.cr) throw new ApiError(409, 'Section already has a CR');

  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'CR user not found');
  if (user.role !== 'cr') throw new ApiError(400, 'User is not a CR');
  if (user.section) throw new ApiError(409, 'CR already belongs to another section');
  if (user.registrationStatus === 'suspended') throw new ApiError(409, 'CR account is suspended');

  await withTransaction(async (tx) => {
    section.cr = user._id;
    await section.save({ session: tx });
    user.section = section._id;
    await user.save({ session: tx });
  });

  await auditFromReq(req, {
    action: 'cr.assign', entityType: 'section', entityId: section._id,
    section: section._id, targetUser: user._id,
    after: { cr: String(user._id) },
  });
  return section;
}

/**
 * EXPLICIT admin reassignment: moves a CR who already belongs to a section
 * to a new (CR-less, active) section. Both sides of the OLD link and both
 * sides of the NEW link are updated inside ONE transaction — any failure
 * rolls everything back. The target section's CR is never silently
 * overwritten: if it has a CR the operation is rejected.
 */
export async function reassignCr(req) {
  const sectionId = v.assertObjectId(req.params.id, 'section id');
  const userId = v.assertObjectId(v.pick(req.body, ['userId']).userId, 'cr user id');

  const section = await Section.findById(sectionId);
  if (!section) throw new ApiError(404, 'Section not found');
  if (section.status !== 'active') throw new ApiError(400, 'Section is archived');
  if (section.cr) throw new ApiError(409, 'Section already has a CR');

  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'CR user not found');
  if (user.role !== 'cr') throw new ApiError(400, 'User is not a CR');
  if (user.registrationStatus === 'suspended') throw new ApiError(409, 'CR account is suspended');
  if (!user.section) throw new ApiError(409, 'CR does not belong to a section — use assign instead');
  if (String(user.section) === String(section._id)) throw new ApiError(409, 'CR already belongs to this section');

  const oldSectionId = user.section;
  await withTransaction(async (tx) => {
    const oldSection = await Section.findById(oldSectionId).session(tx);
    if (oldSection) {
      oldSection.cr = null;
      await oldSection.save({ session: tx });
    }
    section.cr = user._id;
    await section.save({ session: tx });
    user.section = section._id;
    await user.save({ session: tx });
  });

  await auditFromReq(req, {
    action: 'cr.reassign', entityType: 'section', entityId: section._id,
    section: section._id, targetUser: user._id,
    before: { fromSection: String(oldSectionId) },
    after: { cr: String(user._id), toSection: String(section._id) },
  });
  return section;
}

/**
 * EXPLICIT admin removal: clears Section.cr and User.section together in
 * ONE transaction. The CR account itself is NEVER deleted or deactivated.
 */
export async function removeCr(req) {
  const sectionId = v.assertObjectId(req.params.id, 'section id');
  const section = await Section.findById(sectionId);
  if (!section) throw new ApiError(404, 'Section not found');
  if (!section.cr) throw new ApiError(409, 'Section has no CR');
  const crId = section.cr; // captured BEFORE the transaction clears it

  await withTransaction(async (tx) => {
    const cr = await User.findById(section.cr).session(tx);
    section.cr = null;
    await section.save({ session: tx });
    if (cr) {
      cr.section = null;
      await cr.save({ session: tx });
    }
  });

  await auditFromReq(req, {
    action: 'cr.remove', entityType: 'section', entityId: section._id,
    section: section._id, targetUser: crId,
    before: { cr: null }, after: { cr: null, removed: true },
  });
  return section;
}

/* ========================== Admin CR directory ============================ */

const CR_SAFE_FIELDS = 'name email phone section registrationStatus emailVerified activationAt lastLoginAt createdAt';

/**
 * Admin-only CR directory. Read-only — CRs are pre-created via POST /api/admin/crs
 * and assigned/reassigned/removed through the dedicated section routes. The
 * response NEVER contains password hashes or any security field.
 */
export async function listCrsAdmin(req) {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { role: 'cr' };
  if (req.query.section) filter.section = v.assertObjectId(req.query.section, 'section id');
  const search = searchFilter(req.query.search, ['name', 'email']);
  if (search) Object.assign(filter, search);

  const [items, total] = await Promise.all([
    User.find(filter)
      .select(CR_SAFE_FIELDS)
      .populate('section', 'name semester status')
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(total, { page, limit }) };
}

/* ========================= Admin student listing ========================= */

const STUDENT_SAFE_FIELDS = 'name email phone rollNo section registrationStatus emailVerified activationAt lastLoginAt createdAt';

/**
 * Admin-only student directory. Filters (department/session/section) and
 * search (name/rollNo/email) are validated server-side; the response NEVER
 * contains password hashes or any security field. Pagination capped at 100.
 */
export async function listStudentsAdmin(req) {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { role: 'student' };

  if (req.query.section) {
    filter.section = v.assertObjectId(req.query.section, 'section id');
  } else {
    if (req.query.department) {
      const dept = v.assertObjectId(req.query.department, 'department id');
      const sections = await Section.find({ department: dept }).select('_id');
      filter.section = { $in: sections.map((s) => s._id) };
    }
    if (req.query.session) {
      const sess = v.assertObjectId(req.query.session, 'session id');
      const sections = await Section.find({ session: sess }).select('_id');
      const list = sections.map((s) => s._id);
      filter.section = filter.section?.$in
        ? filter.section.$in.filter((id) => list.some((x) => String(x) === String(id)))
        : { $in: list };
      if (!filter.section.$in.length) filter.section = { $in: [] };
    }
  }
  const search = searchFilter(req.query.search, ['name', 'rollNo', 'email']);
  if (search) Object.assign(filter, search);

  const [items, total] = await Promise.all([
    User.find(filter)
      .select(STUDENT_SAFE_FIELDS)
      .populate('section', 'name semester status')
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(total, { page, limit }) };
}

/* ================================ DELETE ================================ */

/** Hard delete for departments. Blocked while any section still references it. */
export async function deleteDepartment(req) {
  const id = v.assertObjectId(req.params.id, 'department id');
  const doc = await Department.findById(id);
  if (!doc) throw new ApiError(404, 'Department not found');
  const sections = await Section.countDocuments({ department: id });
  if (sections > 0) {
    throw new ApiError(400, `Cannot delete: ${sections} section(s) still belong to this department. Delete those first.`);
  }
  await doc.deleteOne();
  await auditFromReq(req, {
    action: 'department.delete', entityType: 'department', entityId: doc._id,
    before: { name: doc.name }, after: { deleted: true },
  });
  return { deleted: true, id: doc._id };
}

/** Hard delete for academic sessions. Blocked while any section still references it. */
export async function deleteSession(req) {
  const id = v.assertObjectId(req.params.id, 'session id');
  const doc = await AcademicSession.findById(id);
  if (!doc) throw new ApiError(404, 'Session not found');
  const sections = await Section.countDocuments({ session: id });
  if (sections > 0) {
    throw new ApiError(400, `Cannot delete: ${sections} section(s) still belong to this session. Delete those first.`);
  }
  await doc.deleteOne();
  await auditFromReq(req, {
    action: 'session.delete', entityType: 'session', entityId: doc._id,
    before: { name: doc.name }, after: { deleted: true },
  });
  return { deleted: true, id: doc._id };
}

/**
 * Hard delete for sections — the biggest structural object, so every dependent
 * is listed explicitly. The error tells the owner exactly what to clear first,
 * bottom-up, so nothing is ever a dead end.
 */
export async function deleteSection(req) {
  const id = v.assertObjectId(req.params.id, 'section id');
  const doc = await Section.findById(id);
  if (!doc) throw new ApiError(404, 'Section not found');

  const [students, subjects, slots, announcements, notes, assignments, assessments, attendance] = await Promise.all([
    User.countDocuments({ section: id, role: 'student' }),
    Subject.countDocuments({ section: id }),
    Timetable.countDocuments({ section: id }),
    Announcement.countDocuments({ section: id }),
    Note.countDocuments({ section: id }),
    Assignment.countDocuments({ section: id }),
    Assessment.countDocuments({ section: id }),
    AttendanceSession.countDocuments({ section: id }),
  ]);
  const blocking = [];
  if (doc.cr) blocking.push('an assigned CR');
  if (students) blocking.push(`${students} student(s)`);
  if (subjects) blocking.push(`${subjects} subject(s)`);
  if (slots) blocking.push(`${slots} timetable slot(s)`);
  if (announcements) blocking.push(`${announcements} announcement(s)`);
  if (notes) blocking.push(`${notes} note(s)`);
  if (assignments) blocking.push(`${assignments} assignment(s)`);
  if (assessments) blocking.push(`${assessments} assessment(s)`);
  if (attendance) blocking.push(`${attendance} attendance session(s)`);
  if (blocking.length) {
    throw new ApiError(400, `Cannot delete this section yet — it still has ${blocking.join(', ')}. Delete those first.`);
  }

  await doc.deleteOne();
  await auditFromReq(req, {
    action: 'section.delete', entityType: 'section', entityId: doc._id,
    before: { name: doc.name }, after: { deleted: true },
  });
  return { deleted: true, id: doc._id };
}

/** Hard delete a CR account. Unlinks them from their section first. */
export async function deleteCr(req) {
  const id = v.assertObjectId(req.params.id, 'CR id');
  const user = await User.findOne({ _id: id, role: 'cr' });
  if (!user) throw new ApiError(404, 'CR not found');
  if (user.section) {
    await Section.updateMany({ _id: user.section, cr: user._id }, { $unset: { cr: 1 } });
  }
  await Notification.deleteMany({ recipient: user._id });
  await user.deleteOne();
  await auditFromReq(req, {
    action: 'cr.delete', entityType: 'user', entityId: user._id,
    before: { email: user.email }, after: { deleted: true },
  });
  return { deleted: true, id: user._id };
}

/** Hard delete a student account, cascading their submissions, marks, notifications. */
export async function deleteStudent(req) {
  const id = v.assertObjectId(req.params.id, 'student id');
  const user = await User.findOne({ _id: id, role: 'student' });
  if (!user) throw new ApiError(404, 'Student not found');

  const submissions = await Submission.find({ student: user._id });
  for (const sub of submissions) destroyAttachmentMetas(sub.files);
  await Submission.deleteMany({ student: user._id });
  await Mark.deleteMany({ student: user._id });
  await Notification.deleteMany({ recipient: user._id });

  await user.deleteOne();
  await auditFromReq(req, {
    action: 'student.delete', entityType: 'user', entityId: user._id,
    before: { email: user.email, rollNo: user.rollNo }, after: { deleted: true, submissions: submissions.length },
  });
  return { deleted: true, id: user._id, submissionsRemoved: submissions.length };
}

/* ============================== Danger zone ============================== */

/**
 * Full system wipe. Deletes EVERYTHING except admin accounts and audit logs:
 * departments, sessions, sections, subjects, CR + student accounts and all the
 * content they own — announcements, notes, assignments, submissions, timetable,
 * attendance, assessments, marks, notifications, avatars and pending OTPs.
 * Cloudinary assets are destroyed best-effort AFTER the database wipe.
 * Guard: the client must send confirm: "DELETE" (typed by the admin in the dialog).
 */
export async function wipeAllData(req) {
  if (String(req.body?.confirm ?? '').trim() !== 'DELETE') {
    throw new ApiError(400, 'Type DELETE to confirm the wipe.');
  }

  // Collect Cloudinary attachments first — after the wipe the metadata is gone.
  const [annDocs, noteDocs, assignDocs, subDocs, people] = await Promise.all([
    Announcement.find().select('files').lean(),
    Note.find().select('files').lean(),
    Assignment.find().select('files').lean(),
    Submission.find().select('files').lean(),
    User.find({ role: { $ne: 'admin' } }).select('avatar').lean(),
  ]);
  const attachments = [];
  for (const d of [...annDocs, ...noteDocs, ...assignDocs, ...subDocs]) attachments.push(...(d.files ?? []));
  for (const u of people) if (u.avatar) attachments.push(u.avatar);

  const deleted = await withTransaction(async (tx) => {
    const wipe = (model, filter) => model.deleteMany(filter, { session: tx }).then((r) => r.deletedCount);
    return {
      announcements: await wipe(Announcement, {}),
      notes: await wipe(Note, {}),
      assignments: await wipe(Assignment, {}),
      submissions: await wipe(Submission, {}),
      timetable: await wipe(Timetable, {}),
      attendanceSessions: await wipe(AttendanceSession, {}),
      attendanceRecords: await wipe(AttendanceRecord, {}),
      assessments: await wipe(Assessment, {}),
      marks: await wipe(Mark, {}),
      notifications: await wipe(Notification, {}),
      subjects: await wipe(Subject, {}),
      sections: await wipe(Section, {}),
      sessions: await wipe(AcademicSession, {}),
      departments: await wipe(Department, {}),
      crAndStudentAccounts: await wipe(User, { role: { $ne: 'admin' } }),
      pendingOtps: await wipe(Otp, {}),
    };
  });

  // Never blocks or rolls back the wipe — DB is authoritative.
  destroyAttachmentMetas(attachments);

  await auditFromReq(req, {
    action: 'system.wipe', entityType: 'system', entityId: null,
    after: { deleted },
  });
  return { deleted, kept: ['admin accounts', 'audit logs'] };
}
