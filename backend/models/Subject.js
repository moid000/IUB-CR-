import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Section-scoped subject. Same subject code may exist in different sections
 * (each section owns its own record) but never twice within one section.
 */
const subjectSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    teacherName: { type: String, trim: true },
    creditHours: { type: Number, min: 0.5, default: null },
    description: { type: String, trim: true },
    section: { type: ObjectId, ref: 'Section', required: true },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true }
);

subjectSchema.index({ section: 1, code: 1 }, { unique: true });
subjectSchema.index({ section: 1, status: 1 });

export default mongoose.model('Subject', subjectSchema);
