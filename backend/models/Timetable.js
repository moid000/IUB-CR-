import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:MM 24h
const DATE_FORMAT = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/; // YYYY-MM-DD

/**
 * Timetable slot — a class on ONE SPECIFIC DATE (daily timetable).
 * date + startTime/endTime are Asia/Karachi WALL-CLOCK values stored as
 * plain strings (YYYY-MM-DD / zero-padded HH:MM 24h). They are calendar
 * data — deliberately NEVER converted to UTC timestamps.
 * The CR sets each day's schedule themselves (any calendar date is
 * allowed, including Sunday) and can copy another day's slots in one call.
 * Same-section/same-date overlap is enforced at the service layer (Step 7).
 */
const timetableSchema = new Schema(
  {
    section: { type: ObjectId, ref: 'Section', required: true },
    subject: { type: ObjectId, ref: 'Subject', required: true },
    date: { type: String, required: true, match: [DATE_FORMAT, 'Invalid date (YYYY-MM-DD)'] },
    startTime: { type: String, required: true, match: [TIME_FORMAT, 'Invalid startTime (HH:MM)'] },
    endTime: {
      type: String,
      required: true,
      match: [TIME_FORMAT, 'Invalid endTime (HH:MM)'],
      validate: {
        validator(value) {
          return value > this.startTime; // zero-padded HH:MM compares correctly
        },
        message: 'endTime must be after startTime',
      },
    },
    room: { type: String, trim: true },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    // Teacher reply is tied to THIS slot and THIS schedule revision. A copied or
    // rescheduled class gets its own reference so old replies cannot confirm it.
    teacherConfirmation: {
      type: new Schema({
        status: { type: String, enum: ['none', 'queued', 'sending', 'awaiting', 'confirmed', 'declined', 'failed'], default: 'none' },
        code: { type: String },
        teacher: { type: ObjectId, ref: 'Teacher' },
        requestedBy: { type: ObjectId, ref: 'User' },
        phone: { type: String },
        attempts: { type: Number, default: 0 },
        nextAttemptAt: { type: Date },
        claimedAt: { type: Date },
        sentAt: { type: Date },
        respondedAt: { type: Date },
        replyId: { type: String },
      }, { _id: false }),
      default: () => ({ status: 'none' }),
    },
  },
  { timestamps: true }
);

timetableSchema.index({ section: 1, date: 1, startTime: 1 });
timetableSchema.index({ section: 1, status: 1 });
timetableSchema.index({ 'teacherConfirmation.code': 1 }, { unique: true, partialFilterExpression: { 'teacherConfirmation.code': { $type: 'string' } } });
timetableSchema.index({ 'teacherConfirmation.status': 1, 'teacherConfirmation.nextAttemptAt': 1 });

export default mongoose.model('Timetable', timetableSchema);
