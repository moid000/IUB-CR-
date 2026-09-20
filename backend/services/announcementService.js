import { Announcement } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { makeSectionContentService } from './sectionContent.js';
import { notifySection } from './notificationService.js';
import { broadcastToSectionGroup, announcementMessage } from './whatsappGroupService.js';
import * as v from '../utils/validators.js';

const assertText = v.assertText;

const TITLE_MAX = 120;
const CONTENT_MAX = 5000;

function assertTitle(value) {
  const title = assertText(value, 'title').trim();
  if (!title || title.length > TITLE_MAX) {
    throw new ApiError(400, `Title must be 1–${TITLE_MAX} characters`);
  }
  return title;
}

function assertContent(value) {
  const content = assertText(value, 'content').trim();
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
  notifyRefType: 'Announcement',
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
    // New announcement → in-app notification for CURRENT active section
    // members. Recipients/dedupe keys are fully server-derived; retries are
    // idempotent via the notification unique index. No email is ever sent.
    afterCreate: async (doc, req) => {
      await notifySection({
        req,
        section: doc.section,
        actorId: req.user._id,
        type: 'announcement',
        title: 'New announcement',
        message: doc.title,
        refType: 'Announcement',
        refId: doc._id,
        dedupePrefix: 'announcement',
      });
      // WhatsApp class-group broadcast (best-effort; marks are never broadcast)
      await broadcastToSectionGroup(doc.section, announcementMessage(doc), doc.attachments);
    },
    applyUpdate: (doc, fields) => {
      if (fields.title !== undefined) doc.title = fields.title;
      if (fields.content !== undefined) doc.content = fields.content;
      if (fields.pinned !== undefined) doc.pinned = fields.pinned;
    },
  },
});
