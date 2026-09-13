import { Announcement } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { makeSectionContentService } from './sectionContent.js';

const TITLE_MAX = 120;
const CONTENT_MAX = 5000;

function assertTitle(value) {
  const title = String(value ?? '').trim();
  if (!title || title.length > TITLE_MAX) {
    throw new ApiError(400, `Title must be 1–${TITLE_MAX} characters`);
  }
  return title;
}

function assertContent(value) {
  const content = String(value ?? '').trim();
  if (!content) throw new ApiError(400, 'Content is required');
  if (content.length > CONTENT_MAX) throw new ApiError(400, `Content must be at most ${CONTENT_MAX} characters`);
  return content;
}

/**
 * Announcements — section-scoped, authored by CR (or Admin).
 *
 * `attachments` is NOT accepted from clients in this phase: the embedded
 * FileMeta structure is preserved and will be populated by the Cloudinary
 * upload phase (direct-upload flow with signed uploads). Any client-supplied
 * attachment payload is silently dropped — file ownership/publicId can never
 * be injected. `pinned` is a safe boolean flag CR/Admin may toggle.
 */
export default makeSectionContentService({
  Model: Announcement,
  kind: 'announcement',
  searchFields: ['title', 'content'],
  defaults: { status: 'published', statusEnum: ['published', 'archived'] },
  hooks: {
    extraFields: ['pinned'],
    validateBody: (body, { partial }) => {
      const fields = {};
      if (body.title !== undefined || !partial) fields.title = assertTitle(body.title);
      if (body.content !== undefined || !partial) fields.content = assertContent(body.content);
      if (body.pinned !== undefined) {
        if (typeof body.pinned !== 'boolean') throw new ApiError(400, 'pinned must be a boolean');
        fields.pinned = body.pinned;
      }
      return fields;
    },
    applyUpdate: (doc, fields) => {
      if (fields.title !== undefined) doc.title = fields.title;
      if (fields.content !== undefined) doc.content = fields.content;
      if (fields.pinned !== undefined) doc.pinned = fields.pinned;
    },
  },
});
