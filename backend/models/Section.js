import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * A section = department + session + semester (1–8) + name (e.g. "3M").
 *
 * Sections are NEVER deleted or overwritten. When a new semester begins, a new
 * Section document is created and the old one is archived with all of its
 * history (subjects, assignments, attendance…) fully linked and queryable.
 *
 * pastMembers is APPEND-ONLY and written exclusively by server-side admin
 * promotion logic — never from client payloads.
 */
const sectionSchema = new Schema(
  {
    department: { type: ObjectId, ref: 'Department', required: true },
    session: { type: ObjectId, ref: 'AcademicSession', required: true },
    semester: { type: Number, required: true, min: 1, max: 8 },
    name: { type: String, required: true, uppercase: true, trim: true },
    cr: { type: ObjectId, ref: 'User', default: null },
    pastMembers: [{ type: ObjectId, ref: 'User' }],
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true }
);

// A section's full identity is unique
sectionSchema.index(
  { department: 1, session: 1, semester: 1, name: 1 },
  { unique: true }
);

// One CR can be assigned to at most ONE section (DB-level guarantee)
sectionSchema.index(
  { cr: 1 },
  { unique: true, partialFilterExpression: { cr: { $exists: true, $type: 'objectId' } } }
);

sectionSchema.index({ session: 1, status: 1 });
sectionSchema.index({ department: 1, status: 1 });

export default mongoose.model('Section', sectionSchema);
