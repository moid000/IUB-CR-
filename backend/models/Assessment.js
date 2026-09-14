import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Assessment (Step 11) — an academic assessment definition for ONE section +
 * ONE subject (e.g. "Quiz 1", "Midterm"). The lifecycle is server-controlled:
 *
 *   draft ──open──> open ──finalize──> finalized ──archive──> archived
 *     └──────────────finalize──────────────┘         └──────────┘
 *                                                  (also from draft/open)
 *
 * - draft: definition editable, marks not entered
 * - open: marks can be entered/updated
 * - finalized: immutable — marks and definition locked, finalizedAt/By server-set
 * - archived: historical read-only
 *
 * `section` is IMMUTABLE after creation: Mark records denormalize section and
 * subject for history, so moving an assessment would corrupt them. `subject`
 * may only be swapped for another ACTIVE subject of the SAME section.
 * No reopen endpoint exists.
 */
const ASSESSMENT_TYPES = ['quiz', 'assignment', 'midterm', 'final', 'practical', 'viva', 'project', 'other'];

const assessmentSchema = new Schema(
  {
    section: { type: ObjectId, ref: 'Section', required: true, immutable: true },
    subject: { type: ObjectId, ref: 'Subject', required: true },
    title: { type: String, required: true, trim: true, minlength: 2, maxlength: 200 },
    type: { type: String, enum: ASSESSMENT_TYPES, required: true },
    totalMarks: {
      type: Number,
      required: true,
      min: 1,
      max: 1000,
      // integers ONLY — the current academic requirements use whole marks;
      // integer storage avoids all floating-point surprises
      validate: {
        validator: (value) => Number.isInteger(value),
        message: 'totalMarks must be a whole number',
      },
    },
    assessmentDate: { type: Date, required: true },
    // Informational only — NO grading formulas / GPA / weighted totals exist
    // anywhere in Step 11. Validated to 0 < weightage <= 100.
    weightage: {
      type: Number,
      min: 0.01,
      max: 100,
      validate: {
        validator: (value) => value === undefined || value === null ||
          (Number.isFinite(value) && Math.round(value * 100) === value * 100), // ≤ 2 decimals
        message: 'weightage allows at most 2 decimal places',
      },
    },
    status: { type: String, enum: ['draft', 'open', 'finalized', 'archived'], default: 'draft' },
    createdBy: { type: ObjectId, ref: 'User', required: true, immutable: true },
    finalizedAt: { type: Date },
    finalizedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// List + filter coverage (documented in the Step 11 report):
assessmentSchema.index({ section: 1, subject: 1, status: 1, assessmentDate: -1 });
assessmentSchema.index({ section: 1, createdAt: -1 });

export default mongoose.model('Assessment', assessmentSchema);
export { ASSESSMENT_TYPES };
