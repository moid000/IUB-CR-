import { Note } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { makeSectionContentService, validateSectionSubject } from './sectionContent.js';
import { notifySection } from './notificationService.js';
import * as v from '../utils/validators.js';

const assertText = v.assertText;

const TITLE_MAX = 120;
const CONTENT_MAX = 10000;

function assertTitle(value) {
  const title = assertText(value, 'title').trim();
  if (!title || title.length > TITLE_MAX) {
    throw new ApiError(400, `Title must be 1–${TITLE_MAX} characters`);
  }
  return title;
}

function assertContent(value) {
  if (value === undefined || value === null || value === '') return undefined; // notes: optional
  const content = assertText(value, 'content').trim();
  if (content.length > CONTENT_MAX) throw new ApiError(400, `Content must be at most ${CONTENT_MAX} characters`);
  return content;
}

/**
 * Notes — section-scoped, optionally linked to a Subject of the SAME section.
 * Subject ownership is validated server-side: a subject from another section
 * is rejected (400), an archived subject is rejected, and clients can never
 * move a note across sections. `attachments` is not client-writable in this
 * phase (Cloudinary comes later).
 */
export default makeSectionContentService({
  Model: Note,
  kind: 'note',
  searchFields: ['title', 'content'],
  defaults: { status: 'published', statusEnum: ['published', 'archived'] },
  hooks: {
    extraFields: ['subject'],
    validateBody: async (body, { partial, ctx }) => {
      const fields = {};
      if (body.title !== undefined || !partial) fields.title = assertTitle(body.title);
      if (body.content !== undefined) fields.content = assertContent(body.content);
      if (body.subject !== undefined) {
        // partial-update with explicit null clears the subject link
        fields.subject = body.subject === null || body.subject === ''
          ? null
          : await validateSectionSubject(body.subject, ctx.sectionId);
      }
      return fields;
    },
    // New note → in-app + device push notification for CURRENT active section
    // members. Recipients/dedupe keys are fully server-derived; retries are
    // idempotent via the notification unique index (same as announcements).
    afterCreate: (doc, req) => notifySection({
      req,
      section: doc.section,
      actorId: req.user._id,
      type: 'note',
      title: 'New note uploaded',
      message: doc.title,
      refType: 'Note',
      refId: doc._id,
      dedupePrefix: 'note',
    }),
    applyUpdate: (doc, fields) => {
      if (fields.title !== undefined) doc.title = fields.title;
      if (fields.content !== undefined) doc.content = fields.content;
      if (fields.subject !== undefined) doc.subject = fields.subject;
    },
    extraFilters: (query) => {
      const filter = {};
      if (query.subjectId) filter.subject = v.assertObjectId(query.subjectId, 'subject id');
      return Object.keys(filter).length ? filter : null;
    },
  },
});
