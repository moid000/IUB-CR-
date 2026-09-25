import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Protected data-deletion (system wipe) verification codes.
 * When the administration requests wipe codes, TWO 6-digit codes are
 * generated: one emailed to the administration profile email, one sent to
 * its WhatsApp number. Both are stored here BCRYPT-HASHED — plaintext codes
 * never touch the database. A wipe only executes when BOTH codes are
 * presented and both hashes match.
 *
 * Single-use: the document is deleted the moment both codes verify (one
 * wipe attempt per code pair). 5 wrong attempts burn the pair.
 */
const wipeVerificationSchema = new Schema(
  {
    emailCodeHash: { type: String, required: true },
    waCodeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Only the latest pair is ever valid; old pairs are removed on each request.
wipeVerificationSchema.index({ createdAt: -1 });

export default mongoose.model('WipeVerification', wipeVerificationSchema);
