import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Mark (Step 11) — ONE student's obtained marks for ONE assessment.
 *
 * - section/subject are DENORMALIZED history: a student who rolls from
 *   Section A to Section B keeps their Section A marks readable forever, but
 *   can never RECEIVE new Section A marks (eligibility is always checked
 *   against the user's CURRENT section at entry time).
 * - One record per (assessment, student) — the unique index below is the
 *   FINAL concurrency arbiter: duplicate-key races are caught and mapped to
 *   a safe 409, never two records.
 * - Missing marks are NOT stored as zeros: a student without a Mark document
 *   is "missing" — computed at read time, never backfilled.
 * - marksObtained is an INTEGER 0..totalMarks (validated against the parent
 *   assessment in the service layer, where totalMarks is known).
 */
const markSchema = new Schema(
  {
    assessment: { type: ObjectId, ref: 'Assessment', required: true, immutable: true },
    section: { type: ObjectId, ref: 'Section', required: true, immutable: true },
    subject: { type: ObjectId, ref: 'Subject', required: true, immutable: true },
    student: { type: ObjectId, ref: 'User', required: true, immutable: true },
    marksObtained: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: (value) => Number.isInteger(value),
        message: 'marksObtained must be a whole number',
      },
    },
    status: { type: String, enum: ['active', 'finalized'], default: 'active' },
    enteredBy: { type: ObjectId, ref: 'User', required: true },
    finalizedAt: { type: Date },
  },
  { timestamps: true }
);

// FINAL concurrency arbiter — exactly one mark per (assessment, student).
markSchema.index({ assessment: 1, student: 1 }, { unique: true });
// Student's own-marks history queries.
markSchema.index({ student: 1, createdAt: -1 });
// CR/Admin "who hasn't been marked yet" + section reports.
markSchema.index({ section: 1, assessment: 1 });

export default mongoose.model('Mark', markSchema);
