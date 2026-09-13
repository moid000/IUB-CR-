import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId, Mixed } = Schema.Types;

/**
 * Append-only audit trail.
 *
 * - No update/delete routes exist for this collection (verified by tests).
 * - CR and STUDENT roles can never read or write audit logs — admin only.
 * - before/after snapshots are sanitized by utils/audit.js (no passwords,
 *   OTP codes, tokens, or secrets are ever persisted).
 */
const auditLogSchema = new Schema(
  {
    actor: { type: ObjectId, ref: 'User', default: null },
    actorRole: { type: String, required: true, default: 'system' },
    action: { type: String, required: true }, // dot notation, e.g. 'attendance.record.revoke'
    entityType: { type: String, trim: true },
    entityId: { type: ObjectId },
    section: { type: ObjectId, ref: 'Section', default: null },
    targetUser: { type: ObjectId, ref: 'User', default: null },
    before: { type: Mixed },
    after: { type: Mixed },
    reason: { type: String, trim: true }, // mandatory for corrections/revocations
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true }
);

auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ section: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

export default mongoose.model('AuditLog', auditLogSchema);
