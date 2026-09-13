import { Section, Subject } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import * as v from '../utils/validators.js';
import { parsePagination, paginationMeta, searchFilter } from '../utils/pagination.js';

/**
 * Factory for section-scoped content services (Announcements, Notes, …).
 *
 * Invariants enforced here — identical for every content type:
 * - Section ownership is ALWAYS server-derived for CR/Student (never client).
 * - Cross-section access resolves to 404 (never 403 — existence must not leak).
 * - No hard delete; archived documents cannot be modified or archived twice.
 * - Client payloads can never inject section/author/status/attachments.
 * - Pagination hard-capped at 100; search regex-escaped; ObjectIds validated.
 *
 * `hooks` lets each content type add validation (e.g. Note → Subject checks).
 */
export function makeSectionContentService({
  Model, kind, searchFields, defaults, hooks = {},
}) {
  const {
    extraFields = [],    // e.g. ['subject'] for Notes — pickable, validated
    validateBody,        // async (body, { partial, ctx }) → validated fields
    applyUpdate,         // (doc, fields, ctx) → void (mutates doc)
    extraFilters,        // (query) → additional validated filters or null
  } = hooks;

  async function activeSection(sectionId) {
    const id = v.assertObjectId(sectionId, 'section id');
    const section = await Section.findById(id);
    if (!section) throw new ApiError(400, 'Section not found');
    if (section.status !== 'active') throw new ApiError(400, 'Section is archived');
    return section;
  }

  async function audit(req, action, doc, extra = {}) {
    await auditFromReq(req, {
      action: `${kind}.${action}`, entityType: kind, entityId: doc._id, section: doc.section,
      ...extra,
    });
  }

  /* ------------------------------- ADMIN ------------------------------- */

  async function createAdmin(req) {
    const body = v.pick(req.body, ['section', 'title', 'content', ...extraFields]);
    const section = await activeSection(body.section); // explicit, validated
    const fields = await validateBody(body, { partial: false, ctx: { req, sectionId: section._id } });
    const doc = await Model.create({
      ...fields,
      section: section._id,
      author: req.user._id, // server-derived — never client input
      status: defaults.status,
    });
    await audit(req, 'create', doc, { after: { title: doc.title, section: String(section._id) } });
    return doc;
  }

  async function listAdmin(req) {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    if (req.query.section) filter.section = v.assertObjectId(req.query.section, 'section id');
    if (req.query.status) filter.status = v.assertEnum(req.query.status, defaults.statusEnum, 'status');
    const extra = extraFilters ? extraFilters(req.query) : null;
    if (extra) Object.assign(filter, extra);
    const search = searchFilter(req.query.search, searchFields);
    if (search) Object.assign(filter, search);

    const [items, total] = await Promise.all([
      Model.find(filter).populate('author', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit),
      Model.countDocuments(filter),
    ]);
    return { items, pagination: paginationMeta(total, { page, limit }) };
  }

  async function getAdmin(req) {
    const id = v.assertObjectId(req.params.id, `${kind} id`);
    const doc = await Model.findById(id).populate('author', 'name');
    if (!doc) throw new ApiError(404, `${KIND_LABEL} not found`);
    return doc;
  }

  async function updateAdmin(req) {
    const id = v.assertObjectId(req.params.id, `${kind} id`);
    const doc = await Model.findById(id);
    if (!doc) throw new ApiError(404, `${KIND_LABEL} not found`);
    if (doc.status === 'archived') throw new ApiError(400, `Archived ${kind.toLowerCase()} cannot be modified`);

    const body = v.pick(req.body, ['title', 'content', ...extraFields]);
    const fields = await validateBody(body, { partial: true, ctx: { req, sectionId: doc.section } });
    const before = { title: doc.title };
    applyUpdate(doc, fields, { req, sectionId: doc.section, partial: true });
    await doc.save();
    await audit(req, 'update', doc, { before, after: { title: doc.title } });
    return doc;
  }

  async function archiveAdmin(req) {
    const id = v.assertObjectId(req.params.id, `${kind} id`);
    const doc = await Model.findById(id);
    if (!doc) throw new ApiError(404, `${KIND_LABEL} not found`);
    if (doc.status === 'archived') throw new ApiError(409, `${KIND_LABEL} already archived`);
    doc.status = 'archived';
    await doc.save(); // content, author, attachments, timestamps all preserved
    await audit(req, 'archive', doc, { before: { status: 'published' }, after: { status: 'archived' } });
    return doc;
  }

  /* -------------------------------- CR -------------------------------- */

  async function createCr(req) {
    const sectionId = req.user.section; // server-derived — body.section never read
    if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');
    await activeSection(sectionId);

    const body = v.pick(req.body, ['title', 'content', ...extraFields]);
    const fields = await validateBody(body, { partial: false, ctx: { req, sectionId } });
    const doc = await Model.create({
      ...fields,
      section: sectionId,
      author: req.user._id,
      status: defaults.status,
    });
    await audit(req, 'create', doc, { after: { title: doc.title, section: String(sectionId) } });
    return doc;
  }

  async function listCr(req) {
    const sectionId = req.user.section;
    if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');
    const { page, limit, skip } = parsePagination(req.query);
    const filter = { section: sectionId };
    if (req.query.status) filter.status = v.assertEnum(req.query.status, defaults.statusEnum, 'status');
    const extra = extraFilters ? extraFilters(req.query) : null;
    if (extra) Object.assign(filter, extra);
    const search = searchFilter(req.query.search, searchFields);
    if (search) Object.assign(filter, search);

    const [items, total] = await Promise.all([
      Model.find(filter).populate('author', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit),
      Model.countDocuments(filter),
    ]);
    return { items, pagination: paginationMeta(total, { page, limit }) };
  }

  const KIND_LABEL = `${kind[0].toUpperCase()}${kind.slice(1)}`; // 'Announcement', 'Note'

  /** Scoped lookup — another section's document is indistinguishable from missing. */
  async function findOwn(req) {
    const id = v.assertObjectId(req.params.id, `${kind} id`);
    const doc = await Model.findOne({ _id: id, section: req.user.section });
    if (!doc) throw new ApiError(404, `${KIND_LABEL} not found`);
    return doc;
  }

  async function getCr(req) {
    if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
    const doc = await findOwn(req);
    await doc.populate('author', 'name');
    return doc;
  }

  async function updateCr(req) {
    if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
    const doc = await findOwn(req);
    if (doc.status === 'archived') throw new ApiError(400, `Archived ${kind.toLowerCase()} cannot be modified`);

    const body = v.pick(req.body, ['title', 'content', ...extraFields]);
    const fields = await validateBody(body, { partial: true, ctx: { req, sectionId: req.user.section } });
    const before = { title: doc.title };
    applyUpdate(doc, fields, { req, sectionId: req.user.section, partial: true });
    await doc.save();
    await audit(req, 'update', doc, { before, after: { title: doc.title } });
    return doc;
  }

  async function archiveCr(req) {
    if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
    const doc = await findOwn(req);
    if (doc.status === 'archived') throw new ApiError(409, `${KIND_LABEL} already archived`);
    doc.status = 'archived';
    await doc.save();
    await audit(req, 'archive', doc, { before: { status: 'published' }, after: { status: 'archived' } });
    return doc;
  }

  /* ------------------------------ STUDENT ------------------------------ */

  async function listStudent(req) {
    const sectionId = req.user.section;
    if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');
    const { page, limit, skip } = parsePagination(req.query, { limit: 100 });
    const filter = { section: sectionId };
    if (req.query.status) filter.status = v.assertEnum(req.query.status, defaults.statusEnum, 'status');
    const extra = extraFilters ? extraFilters(req.query) : null;
    if (extra) Object.assign(filter, extra);
    const search = searchFilter(req.query.search, searchFields);
    if (search) Object.assign(filter, search);

    const [items, total] = await Promise.all([
      Model.find(filter).populate('author', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit),
      Model.countDocuments(filter),
    ]);
    return { items, pagination: paginationMeta(total, { page, limit }) };
  }

  async function getStudent(req) {
    if (!req.user.section) throw new ApiError(400, 'You are not assigned to a section');
    const id = v.assertObjectId(req.params.id, `${kind} id`);
    const doc = await Model.findOne({ _id: id, section: req.user.section }).populate('author', 'name');
    if (!doc) throw new ApiError(404, `${KIND_LABEL} not found`);
    return doc;
  }

  return {
    createAdmin, listAdmin, getAdmin, updateAdmin, archiveAdmin,
    createCr, listCr, getCr, updateCr, archiveCr,
    listStudent, getStudent,
  };
}

/** Shared Subject validator for Note-style content (subject must belong to the same, active section). */
export async function validateSectionSubject(subjectId, sectionId) {
  if (subjectId === undefined || subjectId === null || subjectId === '') return null;
  const id = v.assertObjectId(subjectId, 'subject id');
  const subject = await Subject.findById(id);
  if (!subject) throw new ApiError(400, 'Subject not found');
  if (String(subject.section) !== String(sectionId)) {
    throw new ApiError(400, 'Subject does not belong to this section');
  }
  if (subject.status !== 'active') throw new ApiError(400, 'Subject is archived');
  return id;
}
