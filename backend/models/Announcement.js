import mongoose from 'mongoose';
import FileMetaSchema from './FileMeta.js';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/** Section-scoped announcement authored by the section CR. */
const announcementSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
    attachments: [FileMetaSchema], // embedded Cloudinary metadata
    section: { type: ObjectId, ref: 'Section', required: true },
    author: { type: ObjectId, ref: 'User', required: true },
    pinned: { type: Boolean, default: false },
    status: { type: String, enum: ['published', 'archived'], default: 'published' },
  },
  { timestamps: true }
);

announcementSchema.index({ section: 1, createdAt: -1 });

export default mongoose.model('Announcement', announcementSchema);
