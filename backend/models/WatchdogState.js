import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Watchdog alert throttle — tiny KV store so email alerts fire at most once
 * per ~20h per alert kind (the watchdog itself is pinged hourly by cron).
 *
 * Keys in use:
 *   watchdog:qr            — instance needs a QR scan (WhatsApp session dropped)
 *   watchdog:renew-failed  — extend_trial call failed / instance still stopped
 *   watchdog:last-run      — heartbeat: the most recent watchdog ping (cron every 5 min)
 *   watchdog:last-renewal  — the last time the "Extend trial" button was auto-pressed successfully
 */
const watchdogStateSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    lastSentAt: { type: Date, required: true },
  },
  { timestamps: true },
);

watchdogStateSchema.index({ key: 1 }, { unique: true });

export default mongoose.model('WatchdogState', watchdogStateSchema);
