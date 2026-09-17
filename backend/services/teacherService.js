import { Teacher, Section, Subject } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import * as v from '../utils/validators.js';
import { parsePagination, paginationMeta, searchFilter } from '../utils/pagination.js';

/**
 * Teacher management. One teacher per subject; a subject belongs to exactly
 * one section, so the teacher inherits that section implicitly.
 *
 * Section isolation (same rule as subjects): CR endpoints derive the section
 * ONLY from req.user.section — a teacher/subject of another section resolves
 * to 404, never 403 (which would leak existence).
 */

const NAME_MAX = 80;
const WHATSAPP_MAX = 160;
const TEACHER_FIELDS = 'name subject section whatsapp email designation createdBy createdAt updatedAt';

/**
 * Normalizes a WhatsApp number to international digits WITHOUT '+'.
 * Accepts +92..., 92..., 0301..., 301... — all become 92301... (PK mobile).
 * Returns null when the input cannot be a valid international number.
 */
export function normalizeWhatsApp(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;

  let intl = digits;
  if (!hasPlus) {
    if (intl.startsWith('0')) intl = `92${intl.slice(1)}`;      // 0301… → 92301…
    else if (intl.length <= 10) intl = `92${intl}`;              // 301…   → 92301…
  }
  // Valid international numbers are 10–15 digits total
  if (intl.length < 10 || intl.length > 15) return null;
  return intl;
}

function assertWhatsApp(value) {
  const intl = normalizeWhatsApp(value);
  if (!intl) {
    throw new ApiError(400, 'WhatsApp number must be a valid international number (e.g. +92 301 2345678)');
  }
  return intl;
}

function assertTeacherName(value) {
  const name = v.assertName(value, 'name');
  if (name.length > NAME_MAX) throw new ApiError(400, `Name too long (max ${NAME_MAX} characters)`);
  return name;
}

function assertOptionalEmail(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return v.assertEmail(value, 'email');
}

function assertOptionalText(value, field, max) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = v.assertText(value, field).trim();
  if (text.length > max) throw new ApiError(400, `${field} too long (max ${max} characters)`);
  return text;
}

/**
 * Subject must exist, be ACTIVE, and belong to `sectionId` — otherwise 404
 * (existence never leaked across sections).
 */
async function assertOwnActiveSubject(subjectId, sectionId) {
  const id = v.assertObjectId(subjectId, 'subject id');
  const subject = await Subject.findOne({ _id: id, section: sectionId, status: 'active' });
  if (!subject) throw new ApiError(404, 'Subject not found in your section');
  return subject;
}

async function findOwnTeacher(teacherId, sectionId) {
  const id = v.assertObjectId(teacherId, 'teacher id');
  const teacher = await Teacher.findOne({ _id: id, section: sectionId });
  if (!teacher) throw new ApiError(404, 'Teacher not found');
  return teacher;
}

async function assertSectionActive(sectionId) {
  const section = await Section.findById(sectionId);
  if (!section) throw new ApiError(400, 'You are not assigned to a section');
  if (section.status !== 'active') throw new ApiError(400, 'Section is archived');
  return section;
}

/* ======================= CR/GR endpoints (section-scoped) ======================= */

export async function listTeachersCr(req) {
  const sectionId = req.user.section;
  if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');

  const { page, limit, skip } = parsePagination(req.query);
  const filter = { section: sectionId };
  const search = searchFilter(req.query.search, ['name', 'whatsapp', 'email', 'designation']);
  if (search) Object.assign(filter, search);

  const [items, total] = await Promise.all([
    Teacher.find(filter)
      .select(TEACHER_FIELDS)
      .populate('subject', 'name code status')
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit),
    Teacher.countDocuments(filter),
  ]);
  return { items, pagination: paginationMeta(total, { page, limit }) };
}

export async function createTeacherCr(req) {
  const sectionId = req.user.section;
  if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');
  await assertSectionActive(sectionId);

  const body = v.pick(req.body, ['name', 'subject', 'whatsapp', 'email', 'designation']);
  const name = assertTeacherName(body.name);
  const subject = await assertOwnActiveSubject(body.subject, sectionId);
  const whatsapp = assertWhatsApp(body.whatsapp);

  const existing = await Teacher.findOne({ subject: subject._id });
  if (existing) {
    throw new ApiError(409, `“${subject.name}” already has a teacher — edit the existing entry instead`);
  }

  const teacher = await Teacher.create({
    name,
    subject: subject._id,
    section: sectionId,
    whatsapp,
    email: assertOptionalEmail(body.email),
    designation: assertOptionalText(body.designation, 'designation', WHATSAPP_MAX),
    createdBy: req.user._id,
  });

  await auditFromReq(req, {
    action: 'teacher.create', entityType: 'teacher', entityId: teacher._id, section: sectionId,
    after: { name, subject: subject.name, whatsapp },
  });
  return teacher;
}

export async function updateTeacherCr(req) {
  const sectionId = req.user.section;
  if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');

  const teacher = await findOwnTeacher(req.params.id, sectionId);
  const body = v.pick(req.body, ['name', 'subject', 'whatsapp', 'email', 'designation']);

  if (body.name !== undefined) teacher.name = assertTeacherName(body.name);
  if (body.subject !== undefined && String(body.subject) !== String(teacher.subject)) {
    const subject = await assertOwnActiveSubject(body.subject, sectionId);
    const existing = await Teacher.findOne({ subject: subject._id, _id: { $ne: teacher._id } });
    if (existing) {
      throw new ApiError(409, `“${subject.name}” already has a teacher — edit the existing entry instead`);
    }
    teacher.subject = subject._id;
  }
  if (body.whatsapp !== undefined) teacher.whatsapp = assertWhatsApp(body.whatsapp);
  if (body.email !== undefined) teacher.email = assertOptionalEmail(body.email);
  if (body.designation !== undefined) {
    teacher.designation = assertOptionalText(body.designation, 'designation', WHATSAPP_MAX);
  }

  await teacher.save();
  await auditFromReq(req, {
    action: 'teacher.update', entityType: 'teacher', entityId: teacher._id, section: sectionId,
    after: { name: teacher.name, whatsapp: teacher.whatsapp },
  });
  return teacher;
}

export async function deleteTeacherCr(req) {
  const sectionId = req.user.section;
  if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');

  const teacher = await findOwnTeacher(req.params.id, sectionId);
  const before = { name: teacher.name, whatsapp: teacher.whatsapp };
  await teacher.deleteOne();
  await auditFromReq(req, {
    action: 'teacher.delete', entityType: 'teacher', entityId: teacher._id, section: sectionId,
    before,
  });
  return { _id: teacher._id };
}
