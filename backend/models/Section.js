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
    gr: { type: ObjectId, ref: 'User', default: null },
    // Class WhatsApp group for section broadcasts (set by the section's CR/GR).
    // id is the WhatsApp group JID ("1234-5678@g.us"); null when not linked.
    whatsappGroup: {
      type: new Schema(
        {
          id: { type: String, required: true, trim: true },
          name: { type: String, required: true, trim: true },
          linkedBy: { type: ObjectId, ref: 'User' },
          linkedAt: { type: Date, default: Date.now },
        },
        { _id: false }
      ),
      default: null,
    },
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

// One CR / one GR can be assigned to at most ONE section (DB-level guarantee)
sectionSchema.index(
  { cr: 1 },
  { unique: true, partialFilterExpression: { cr: { $exists: true, $type: 'objectId' } } }
);
sectionSchema.index(
  { gr: 1 },
  { unique: true, partialFilterExpression: { gr: { $exists: true, $type: 'objectId' } } }
);

sectionSchema.index({ session: 1, status: 1 });
sectionSchema.index({ department: 1, status: 1 });

export default mongoose.model('Section', sectionSchema);
