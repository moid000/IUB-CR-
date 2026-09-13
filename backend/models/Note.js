import mongoose from 'mongoose';
import FileMetaSchema from './FileMeta.js';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Section-scoped notes uploaded by the CR for their section.
 * Subject is optional; when present, the service layer must verify it
 * belongs to the same section.
 */
const noteSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    subject: { type: ObjectId, ref: 'Subject', default: null },
    content: { type: String, trim: true },
    attachments: [FileMetaSchema],
    section: { type: ObjectId, ref: 'Section', required: true },
    author: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['published', 'archived'], default: 'published' },
  },
  { timestamps: true }
);

noteSchema.index({ section: 1, createdAt: -1 });
noteSchema.index({ section: 1, subject: 1 });

export default mongoose.model('Note', noteSchema);
