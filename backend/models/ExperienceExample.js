import mongoose from 'mongoose';

const { Schema } = mongoose;

/* OWNER night #8 follow-up (2026-10-08): EXPERIENCE LIBRARY made DB-backed.
 * Curated real teacher-agent exchanges (kind classify: teacher msg -> the
 * correct verdict; kind chat: teacher msg -> the agent's actual good reply)
 * injected as few-shots into the classifier + chat prompts. Seeds come from
 * the static library; refreshExperienceLibrary() adds REAL examples from
 * live teacherConfirmation.conversation[] history. */
const experienceExampleSchema = new Schema(
  {
    kind: { type: String, enum: ['classify', 'chat'], required: true },
    input: { type: String, required: true, trim: true, maxlength: 300 },
    output: { type: String, required: true, trim: true, maxlength: 400 },
    source: { type: String, enum: ['seed', 'real'], default: 'seed' },
    active: { type: Boolean, default: true },
    dedupeKey: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

experienceExampleSchema.index({ kind: 1, active: 1, source: 1 });

export default mongoose.models.ExperienceExample
  ?? mongoose.model('ExperienceExample', experienceExampleSchema);
