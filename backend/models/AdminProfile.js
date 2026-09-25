import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Administration profile — singleton record (key: 'administration').
 * Holds the owner/administration's contact details used for the protected
 * data-deletion flow: wiping Tri3M data requires a verification code emailed
 * to this email AND a second code sent to this WhatsApp number. Both must be
 * entered — no account (not even an admin session or an agent) can delete
 * data without receiving both codes from these two channels.
 */
const adminProfileSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    name: { type: String, trim: true, default: '' },
    email: { type: String, required: true, trim: true, lowercase: true },
    // International WhatsApp number, digits only (E.164 without '+'), e.g. 923019670950
    whatsapp: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

adminProfileSchema.index({ key: 1 }, { unique: true });

export default mongoose.model('AdminProfile', adminProfileSchema);
