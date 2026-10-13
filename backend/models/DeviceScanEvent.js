import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Every scan the device sends — the idempotency ledger (the same shape as
 * WhatsAppEvent.botHandled / TeacherQuestion claims). scanId is generated
 * ON the device and is unique: a webhook retry, an offline-queue resync or
 * a flaky WiFi double-POST can never double-mark attendance. The stored
 * `result` is replayed verbatim to the device so a redelivery gets the
 * SAME answer, not a second marking.
 */
const deviceScanEventSchema = new Schema(
  {
    deviceId: { type: ObjectId, ref: 'AttendanceDevice', required: true },
    scanId: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
    fingerprintId: { type: Number, min: 1, max: 192, default: null },
    occurredAt: { type: Date, default: null }, // device clock (offline sync may be old)
    receivedAt: { type: Date, default: Date.now },
    result: {
      type: String,
      enum: ['pending', 'marked', 'duplicate', 'rejected', 'no_class'],
      default: 'pending',
    },
    reason: { type: String, trim: true, maxlength: 60 },
    session: { type: ObjectId, ref: 'AttendanceSession', default: null },
    student: { type: ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

deviceScanEventSchema.index({ deviceId: 1, receivedAt: -1 });

export default mongoose.model('DeviceScanEvent', deviceScanEventSchema);
