import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * ClientError — a render crash beacon POSTed by the frontend error
 * boundaries (2026-10-14 owner incident: the Administration page hits the
 * "This page couldn't load" card on his device but nothing reproduces with
 * realistic data on the server — the REAL error message was invisible).
 * Stores the sanitized error head + component stack head so the owner's
 * agent can read the exact crash cause via ops-diagnostics.
 * No PII, no tokens, tiny capped fields, trimmed automatically.
 */
const clientErrorSchema = new Schema(
  {
    // which boundary reported: 'page' (per-route) | 'root' (top-level)
    kind: { type: String, enum: ['page', 'root', 'preload'], default: 'page' },
    message: { type: String, trim: true, maxlength: 300 },
    stackHead: { type: String, trim: true, maxlength: 300 },
    componentHead: { type: String, trim: true, maxlength: 300 },
    // window.location.pathname + hash at crash time
    path: { type: String, trim: true, maxlength: 200 },
    userAgent: { type: String, trim: true, maxlength: 200 },
    at: { type: Date, default: Date.now },
  },
  { capped: { size: 512 * 1024, max: 500 } }
);

clientErrorSchema.index({ at: -1 });

export default mongoose.models.ClientError || mongoose.model('ClientError', clientErrorSchema);
