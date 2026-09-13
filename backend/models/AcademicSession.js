import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Academic session, e.g. "2026–27". Exactly ONE session can be active at a time. */
const sessionSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    startedAt: { type: Date },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

sessionSchema.index({ name: 1 }, { unique: true });

// DB-level guarantee: only ONE active academic session can ever exist
sessionSchema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

export default mongoose.model('AcademicSession', sessionSchema);
