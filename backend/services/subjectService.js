import { Section, Subject } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import * as v from '../utils/validators.js';
import { parsePagination, paginationMeta, searchFilter } from '../utils/pagination.js';

/**
 * Subject management. Subject belongs to EXACTLY ONE section.
 *
 * Section isolation (critical):
 * - Admin may manage subjects of any ACTIVE section explicitly.
 * - CR endpoints derive the section ONLY from req.user.section — a subject
 *   of another section resolves to 404 (never 403, which would leak existence).
 * - Students are read-only and scoped to their own section the same way.
 *
 * Codes are normalized to UPPERCASE and unique per section (DB index).
 * No hard delete — subjects are archived; historical references stay valid.
 */

const SUBJECT_CODE_RE = /^[A-Z0-9-]{2,16}$/;
const SUBJECT_NAME_MAX = 80;
const SAFE_FIELDS = 'name code teacherName creditHours description section createdBy status createdAt updatedAt';

function assertCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!SUBJECT_CODE_RE.test(code)) {
    throw new ApiError(400, 'Invalid subject code (2–16 letters/digits/dashes, e.g. AI-101)');
  }
  return code;
}

function assertName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > SUBJECT_NAME_MAX) {
    throw new ApiError(400, `Subject name must be 1–${SUBJECT_NAME_MAX} characters`);
  }
  return name;
}

function assertDescription(value) {
  if (value === undefined || value === null) return undefined;
  const description = String(value).trim();
  if (description.length > 1000) throw new ApiError(400, 'Description too long (max 1000)');
  return description || undefined;
}

function assertCreditHours(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.5 || n > 12) throw new ApiError(400, 'creditHours must be 0.5–12');
  return n;
}

/**
 * Picks ONLY editable subject fields. `section` and `createdBy` are
 * deliberately NOT pickable from any client payload — they are always
 * server-derived by the callers.
 */
function parseBody(body) {
  return v.pick(body, ['name', 'code', 'teacherName', 'creditHours', 'description']);
}

async function assertActiveSection(sectionId, { scoped = false } = {}) {
  const id = v.assertObjectId(sectionId, 'section id');
  const section = await Section.findById(id);
  if (!section) throw new ApiError(400, 'Section not found');
  if (section.status !== 'active') throw new ApiError(400, 'Section is archived');
  return section;
}

/* ============================ ADMIN endpoints ============================ */

export async function createSubjectAdmin(req) {
  const body = v.pick(req.body, ['section', 'name', 'code', 'teacherName', 'creditHours', 'description']);
  const section = await assertActiveSection(body.section);
  const core = parseBody(body);
  const name = assertName(core.name);
  const code = assertCode(core.code);
  const teacherName = core.teacherName !== undefined && core.teacherName !== null
    ? String(core.teacherName).trim() : undefined;

  const doc = await Subject.create({
    section: section._id, // server-resolved from the validated id
    name,
    code,
    teacherName: teacherName || undefined,
    creditHours: assertCreditHours(core.creditHours),
    description: assertDescription(core.description),
    createdBy: req.user._id, // server-derived — never client input
    status: 'active',
  });

  await auditFromReq(req, {
    action: 'subject.create', entityType: 'subject', entityId: doc._id, section: section._id,
    after: { name, code, section: String(section._id), status: 'active' },
  });
  return doc;
}

export async function listSubjectsAdmin(req) {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.sectionId) filter.section = v.assertObjectId(req.query.sectionId, 'section id');
  if (req.query.status) filter.status = v.assertEnum(req.query.status, ['active', 'archived'], 'status');
  const search = searchFilter(req.query.search, ['name', 'code']);
  if (search) Object.assign(filter, search);

  const [items, total] = await Promise.all([
    Subject.find(filter).populate('section', 'name semester status').sort({ code: 1, name: 1 }).skip(skip).limit(limit),
    Subject.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(total, { page, limit }) };
}

export async function getSubjectAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'subject id');
  const doc = await Subject.findById(id).populate('section', 'name semester status');
  if (!doc) throw new ApiError(404, 'Subject not found');
  return doc;
}

export async function updateSubjectAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'subject id');
  const doc = await Subject.findById(id);
  if (!doc) throw new ApiError(404, 'Subject not found');
  if (doc.status === 'archived') throw new ApiError(400, 'Archived subject cannot be updated');

  const core = parseBody(req.body);
  const before = { name: doc.name, code: doc.code, description: doc.description };
  if (core.name !== undefined) doc.name = assertName(core.name);
  if (core.code !== undefined) doc.code = assertCode(core.code);
  if (core.teacherName !== undefined) doc.teacherName = core.teacherName === null ? undefined : String(core.teacherName).trim() || undefined;
  if (core.creditHours !== undefined) doc.creditHours = assertCreditHours(core.creditHours);
  if (core.description !== undefined) doc.description = assertDescription(core.description);
  await doc.save(); // duplicate section+code → 11000 → 409

  await auditFromReq(req, {
    action: 'subject.update', entityType: 'subject', entityId: doc._id, section: doc.section,
    before, after: { name: doc.name, code: doc.code },
  });
  return doc;
}

export async function archiveSubjectAdmin(req) {
  const id = v.assertObjectId(req.params.id, 'subject id');
  const doc = await Subject.findById(id);
  if (!doc) throw new ApiError(404, 'Subject not found');
  if (doc.status === 'archived') throw new ApiError(409, 'Subject already archived');
  doc.status = 'archived';
  await doc.save();
  await auditFromReq(req, {
    action: 'subject.archive', entityType: 'subject', entityId: doc._id, section: doc.section,
    before: { status: 'active' }, after: { status: 'archived' },
  });
  return doc;
}

/* ============================= CR endpoints ============================= */
/* section is ALWAYS req.user.section — client input is never consulted. */

export async function createSubjectCr(req) {
  const sectionId = req.user.section; // server-derived
  if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');
  await assertActiveSection(sectionId);

  const core = parseBody(req.body);
  const name = assertName(core.name);
  const code = assertCode(core.code);
  const teacherName = core.teacherName !== undefined && core.teacherName !== null
    ? String(core.teacherName).trim() : undefined;

  const doc = await Subject.create({
    section: sectionId,
    name,
    code,
    teacherName: teacherName || undefined,
    creditHours: assertCreditHours(core.creditHours),
    description: assertDescription(core.description),
    createdBy: req.user._id,
    status: 'active',
  });

  await auditFromReq(req, {
    action: 'subject.create', entityType: 'subject', entityId: doc._id, section: sectionId,
    after: { name, code, section: String(sectionId), status: 'active' },
  });
  return doc;
}

export async function listSubjectsCr(req) {
  const sectionId = req.user.section;
  if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { section: sectionId };
  if (req.query.status) filter.status = v.assertEnum(req.query.status, ['active', 'archived'], 'status');
  const search = searchFilter(req.query.search, ['name', 'code']);
  if (search) Object.assign(filter, search);

  const [items, total] = await Promise.all([
    Subject.find(filter).sort({ code: 1, name: 1 }).skip(skip).limit(limit),
    Subject.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(total, { page, limit }) };
}

/** Cross-section subject resolves to 404 — never 403 (existence must not leak). */
async function findOwnSubject(req) {
  const id = v.assertObjectId(req.params.id, 'subject id');
  const doc = await Subject.findOne({ _id: id, section: req.user.section });
  if (!doc) throw new ApiError(404, 'Subject not found');
  return doc;
}

export async function getSubjectCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  return findOwnSubject(req);
}

export async function updateSubjectCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const doc = await findOwnSubject(req);
  if (doc.status === 'archived') throw new ApiError(400, 'Archived subject cannot be updated');

  const core = parseBody(req.body);
  const before = { name: doc.name, code: doc.code };
  if (core.name !== undefined) doc.name = assertName(core.name);
  if (core.code !== undefined) doc.code = assertCode(core.code);
  if (core.teacherName !== undefined) doc.teacherName = core.teacherName === null ? undefined : String(core.teacherName).trim() || undefined;
  if (core.creditHours !== undefined) doc.creditHours = assertCreditHours(core.creditHours);
  if (core.description !== undefined) doc.description = assertDescription(core.description);
  await doc.save(); // duplicate code within own section → 11000 → 409

  await auditFromReq(req, {
    action: 'subject.update', entityType: 'subject', entityId: doc._id, section: doc.section,
    before, after: { name: doc.name, code: doc.code },
  });
  return doc;
}

export async function archiveSubjectCr(req) {
  if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
  const doc = await findOwnSubject(req);
  if (doc.status === 'archived') throw new ApiError(409, 'Subject already archived');
  doc.status = 'archived';
  await doc.save();
  await auditFromReq(req, {
    action: 'subject.archive', entityType: 'subject', entityId: doc._id, section: doc.section,
    before: { status: 'active' }, after: { status: 'archived' },
  });
  return doc;
}

/* =========================== STUDENT (read-only) =========================== */

export async function listSubjectsStudent(req) {
  const sectionId = req.user.section;
  if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');
  const { page, limit, skip } = parsePagination(req.query, { limit: 100 });
  const filter = { section: sectionId };
  if (req.query.status) filter.status = v.assertEnum(req.query.status, ['active', 'archived'], 'status');
  const search = searchFilter(req.query.search, ['name', 'code']);
  if (search) Object.assign(filter, search);

  const [items, total] = await Promise.all([
    Subject.find(filter).sort({ code: 1, name: 1 }).skip(skip).limit(limit),
    Subject.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(total, { page, limit }) };
}

export { SAFE_FIELDS };
