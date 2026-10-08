import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * VOICE NOTE DIAGNOSTICS (owner incident 2026-10-08): a teacher voice note
 * got NO reply and there was NO way to see why — runtime logs are not
 * readable on the current Vercel plan and every transcription failure is
 * silent BY DESIGN. This best-effort audit trail records each voice note
 * the webhook RECEIVES and how far it got (media URL found? bytes? mime?
 * which engine answered? transcript? error?), so a single owner request
 * can pinpoint the failing hop. Written by the voice branches only;
 * nothing else reads or writes it except the sweep-secret-protected
 * debug endpoint. Records self-trim to the latest 200.
 */
const voiceDiagSchema = new Schema(
  {
    channel: { type: String, enum: ['teacher', 'group'], required: true },
    phone: { type: String, trim: true, maxlength: 20 }, // digits only, no @c.us
    msgType: { type: String, trim: true, maxlength: 16 }, // audio/voice/ptt/ogg
    urlFound: { type: Boolean, default: false },
    mediaBytes: { type: Number, default: 0 },
    mime: { type: String, trim: true, maxlength: 40 },
    engine: { type: String, enum: ['gemini', 'whisper', null], default: null },
    transcript: { type: String, trim: true, maxlength: 800 },
    error: { type: String, trim: true, maxlength: 300 },
    latencyMs: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

voiceDiagSchema.index({ createdAt: -1 });

const VoiceDiag = mongoose.model('VoiceDiag', voiceDiagSchema);

/** Best-effort record + self-trim; NEVER throws into the voice flow. */
export async function recordVoiceDiag(entry) {
  try {
    await VoiceDiag.create(entry);
    // keep only the latest 200 — diagnostics, not a chat archive
    const keep = await VoiceDiag.find({}).sort({ createdAt: -1 }).limit(200).select('_id').lean();
    if (keep.length === 200) {
      await VoiceDiag.deleteMany({ _id: { $nin: keep.map((d) => d._id) } });
    }
  } catch { /* diagnostics must never break the reply pipeline */ }
}

export default VoiceDiag;
