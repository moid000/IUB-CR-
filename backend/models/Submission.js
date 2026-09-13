import mongoose from 'mongoose';
import FileMetaSchema from './FileMeta.js';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * One submission per student per assignment (DB-level guarantee below).
 * `section` is intentionally denormalized for secure/scoped queries.
 * Student and section are ALWAYS derived server-side from the authenticated
 * user — clients can never choose them.
 */
const submissionSchema = new Schema(
  {
    assignment: { type: ObjectId, ref: 'Assignment', required: true },
    student: { type: ObjectId, ref: 'User', required: true },
    section: { type: ObjectId, ref: 'Section', required: true },
    textAnswer: { type: String, trim: true },
    files: [FileMetaSchema],
    isLate: { type: Boolean, default: false },
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

submissionSchema.index({ assignment: 1, student: 1 }, { unique: true });
submissionSchema.index({ student: 1, updatedAt: -1 });
submissionSchema.index({ assignment: 1 });

export default mongoose.model('Submission', submissionSchema);
