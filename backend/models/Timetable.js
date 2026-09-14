import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:MM 24h

// Canonical lowercase day names — Sunday is NOT a working day.
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Timetable slot — recurring WEEKLY class for one section + subject.
 * day + startTime/endTime are Asia/Karachi WALL-CLOCK values stored as
 * zero-padded HH:MM 24h strings. They are recurring weekly schedule data —
 * they are deliberately NEVER converted to UTC timestamps.
 * Same-section/same-day overlap is enforced at the service layer (Step 7).
 */
const timetableSchema = new Schema(
  {
    section: { type: ObjectId, ref: 'Section', required: true },
    subject: { type: ObjectId, ref: 'Subject', required: true },
    day: { type: String, enum: DAYS, required: true },
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
  },
  { timestamps: true }
);

timetableSchema.index({ section: 1, day: 1, startTime: 1 });
timetableSchema.index({ section: 1, status: 1 });

export default mongoose.model('Timetable', timetableSchema);
