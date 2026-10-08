import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Teacher profile — one teacher per subject (per section, since every subject
 * belongs to exactly one section). CR/GR manages teachers from their own
 * portal; the section is ALWAYS server-derived and never trusted from clients.
 *
 * `whatsapp` is stored in international digits WITHOUT '+' (UltraMsg format,
 * e.g. 923001234567) — normalized and validated in teacherService.
 */
const teacherSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    subject: { type: ObjectId, ref: 'Subject', required: true },
    section: { type: ObjectId, ref: 'Section', required: true },
    whatsapp: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    designation: { type: String, trim: true },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    // OWNER night #8 (2026-10-08): PER-TEACHER MEMORY — the agent learns each
    // teacher's language from their own messages; 'auto' = agent detects.
    chatProfile: {
      preferredLanguage: { type: String, enum: ['auto', 'english', 'roman_urdu', 'urdu'], default: 'auto' },
      detectedLanguage: { type: String },
      romanCount: { type: Number, default: 0 },
      englishCount: { type: Number, default: 0 },
    },
    // OWNER night #8 (2026-10-08): PER-TEACHER MEMORY — the agent learns each
    // teacher's language from their own messages; 'auto' = agent detects.
    chatProfile: {
      preferredLanguage: { type: String, enum: ['auto', 'english', 'roman_urdu', 'urdu'], default: 'auto' },
      detectedLanguage: { type: String },
      romanCount: { type: Number, default: 0 },
      englishCount: { type: Number, default: 0 },
    },
    // OWNER night #8 (2026-10-08): PER-TEACHER MEMORY — the agent learns each
    // teacher's language from their own messages; 'auto' = agent detects.
    chatProfile: {
      preferredLanguage: { type: String, enum: ['auto', 'english', 'roman_urdu', 'urdu'], default: 'auto' },
      detectedLanguage: { type: String },
      romanCount: { type: Number, default: 0 },
      englishCount: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

// One subject can have at most ONE teacher record (DB-level guarantee)
teacherSchema.index({ subject: 1 }, { unique: true });
teacherSchema.index({ section: 1, name: 1 });
teacherSchema.index({ section: 1, updatedAt: -1 });

export default mongoose.model('Teacher', teacherSchema);
