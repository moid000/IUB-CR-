import { Schema } from 'mongoose';

/**
 * Embedded subdocument — NOT a standalone collection.
 * Cloudinary file metadata is always stored inline on its parent document
 * (Announcement/Note/Assignment/Submission). No binary data lives in MongoDB.
 */
const FileMetaSchema = new Schema(
  {
    publicId: { type: String, required: true },
    url: { type: String, required: true }, // Cloudinary secure_url
    resourceType: String,
    format: String,
    originalName: String,
    size: Number,
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

export default FileMetaSchema;
