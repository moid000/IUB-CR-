import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:MM 24h

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Timetable slot — arbitrary timeslots set by the CR
 * (day + start/end wall-clock times in HH:MM, interpreted in Asia/Karachi).
 * Cross-slot overlap is enforced later at the service layer.
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
