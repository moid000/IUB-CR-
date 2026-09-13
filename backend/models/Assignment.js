import mongoose from 'mongoose';
import FileMetaSchema from './FileMeta.js';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Section-scoped assignment. `subject` must belong to the same section
 * (verified at service level — client-provided section IDs are never trusted).
 */
const assignmentSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    instructions: { type: String, trim: true },
    subject: { type: ObjectId, ref: 'Subject', required: true },
    section: { type: ObjectId, ref: 'Section', required: true },
    deadline: { type: Date, required: true },
    attachments: [FileMetaSchema],
    createdBy: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['published', 'archived'], default: 'published' },
  },
  { timestamps: true }
);

assignmentSchema.index({ section: 1, deadline: 1 });
assignmentSchema.index({ section: 1, createdAt: -1 });
assignmentSchema.index({ subject: 1 });

export default mongoose.model('Assignment', assignmentSchema);
