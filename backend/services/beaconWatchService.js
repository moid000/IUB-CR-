/**
 * Beacon watch (owner spec 2026-10-14): self-hosted, ZERO-Base44 companion
 * to the client-error beacon. The owner's existing cron-job.org ping already
 * hits /api/whatsapp/deadline-sweep every 5 minutes — this service rides the
 * SAME ping (same pattern as classReminderService) so no new infrastructure,
 * no external dependency and no platform credits are involved.
 *
 * What it does per pass:
 *   1. Reads the cursor (WatchdogState key 'beacon-watch:last-seen').
 *      Missing cursor => initialize to NOW (historical rows are ignored —
 *      only crashes that happen from activation onward alert).
 *   2. Counts/loads ClientError beacons with at > cursor.
 *   3. If new beacons exist, emails the owner's watchdog alert addresses
 *      via Brevo (throttled to one email per BEACON_ALERT_MINUTES, default
 *      15) with the crash heads — the agent can then read the full reports
 *      through ops-diagnostics.
 *   4. Advances the cursor so every beacon alerts exactly once.
 *
 * Never throws — the caller wraps in .catch and the deadline sweep result
 * is never affected.
 */
import ClientError from '../models/ClientError.js';
import WatchdogState from '../models/WatchdogState.js';
import { sendWatchdogAlertEmail } from './emailService.js';

const CURSOR_KEY = 'beacon-watch:last-seen';
const THROTTLE_KEY = 'beacon-watch:last-alert';
const THROTTLE_MS = Number(process.env.BEACON_ALERT_MINUTES ?? 15) * 60 * 1000;
const MAX_ROWS_IN_EMAIL = 5;

async function readCursor() {
  const doc = await WatchdogState.findOne({ key: CURSOR_KEY }).lean();
  return doc ? doc.lastSentAt : null;
}

function formatRow(row) {
  const at = row.at instanceof Date ? row.at.toISOString() : String(row.at);
  const head = (row.message || '(no message)').slice(0, 160);
  return `- [${row.kind || 'page'}] ${at} ${row.path || '/'}\n  ${head}`;
}

/**
 * One watch pass. Returns { initialized, newErrors, alerted, rows } for the
 * sweep report — always safe to JSON.
 */
export async function runBeaconWatch() {
  let cursor = await readCursor();
  if (!cursor) {
    // First activation: start the cursor now, never alert on old rows.
    const now = new Date();
    await WatchdogState.updateOne(
      { key: CURSOR_KEY },
      { $set: { lastSentAt: now } },
      { upsert: true },
    );
    return { initialized: true, newErrors: 0, alerted: false, rows: [] };
  }

  const rows = await ClientError.find({ at: { $gt: cursor } })
    .sort({ at: 1 })
    .limit(20)
    .lean();
  if (rows.length === 0) {
    return { initialized: false, newErrors: 0, alerted: false, rows: [] };
  }

  // Advance the cursor to the newest beacon so nothing double-alerts.
  const newest = rows[rows.length - 1].at;
  await WatchdogState.updateOne(
    { key: CURSOR_KEY },
    { $set: { lastSentAt: newest } },
    { upsert: true },
  );

  // Throttle: at most one alert email per THROTTLE_MS window.
  let alerted = false;
  const throttleDoc = await WatchdogState.findOne({ key: THROTTLE_KEY }).lean();
  const lastAlert = throttleDoc ? throttleDoc.lastSentAt : null;
  if (!lastAlert || Date.now() - lastAlert.getTime() >= THROTTLE_MS) {
    const lines = rows.slice(0, MAX_ROWS_IN_EMAIL).map(formatRow);
    const extra = rows.length > MAX_ROWS_IN_EMAIL ? `\n(+${rows.length - MAX_ROWS_IN_EMAIL} more)` : '';
    alerted = await sendWatchdogAlertEmail({
      subject: `Tri3M — ${rows.length} new client crash beacon${rows.length > 1 ? 's' : ''}`,
      text:
        'The Administration crash beacon recorded new client errors:\n\n' +
        lines.join('\n') + extra +
        '\n\nFull sanitized reports: GET /api/whatsapp/ops-diagnostics (sweep secret required).',
    });
    if (alerted) {
      await WatchdogState.updateOne(
        { key: THROTTLE_KEY },
        { $set: { lastSentAt: new Date() } },
        { upsert: true },
      );
    }
  }

  return { initialized: false, newErrors: rows.length, alerted, rows };
}
