import { ApiError } from '../middleware/error.js';

/**
 * Standard patterns for section-scoped access.
 *
 * Use these helpers in CR/STUDENT routes instead of raw Model.find/findOne,
 * so a route can never accidentally read or write another section's data.
 * The section is derived ONLY from the authenticated user.
 *
 * Admin routes opt out EXPLICITLY with model-wide queries — never through these helpers.
 */

export const sectionFilter = (req) => ({ section: req.user.section });

export function scopedFind(Model, req, filter = {}) {
  return Model.find({ ...filter, section: req.user.section });
}

export function scopedFindById(Model, req, id, filter = {}) {
  return Model.findOne({ ...filter, _id: id, section: req.user.section });
}

export function scopedCount(Model, req, filter = {}) {
  return Model.countDocuments({ ...filter, section: req.user.section });
}

/** Asserts a document belongs to the caller's section (for write operations). */
export function assertOwnsSection(doc, req) {
  if (!doc || String(doc.section) !== String(req.user.section)) {
    throw new ApiError(404, 'Not found');
  }
}
