import { Router } from 'express';
import { env } from '../config/env.js';
import { WatchdogState, Timetable } from '../models/index.js';

/** TEMPORARY read-only system-status route (removed right after use). */
const router = Router();

router.get('/system-status', async (req, res) => {
  const given = String(req.headers['x-wipe-secret'] ?? req.query.secret ?? '');
  if (!process.env.TEMP_WIPE_SECRET || given !== process.env.TEMP_WIPE_SECRET) return res.status(404).json({ success: false, message: 'Not found' });
  try {
    // 1) cron heartbeat evidence from watchdog state
    const keys = await WatchdogState.find({}).lean();
    const watchdog = {};
    for (const k of keys) watchdog[k.key] = k.lastSentAt instanceof Date ? k.lastSentAt.toISOString() : String(k.lastSentAt);
    // 2) live UltraMsg instance status
    let ultramsg = null;
    try {
      const url = `${env.whatsapp.apiUrl || 'https://api.ultramsg.com'}/${env.whatsapp.instanceId}/instance/status?token=${env.whatsapp.token}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      ultramsg = await r.json();
    } catch (e) { ultramsg = { error: e.message }; }
    // 3) teacher confirmation queue
    let confirmations = null;
    try {
      const groups = await Timetable.aggregate([{ $unwind: '$slots' }, { $match: { 'slots.teacherConfirmation.status': { $ne: 'none' } } }, { $group: { _id: '$slots.teacherConfirmation.status', n: { $sum: 1 } } }]);
      confirmations = Object.fromEntries(groups.map((g) => [g._id, g.n]));
    } catch (e) { confirmations = { error: e.message }; }
    res.json({ success: true, now: new Date().toISOString(), envConfigured: { sweepSecret: !!env.whatsapp.sweepSecret, ultramsgToken: !!env.whatsapp.token, instanceId: env.whatsapp.instanceId, gatewayPhone: env.whatsapp.gatewayPhone || null }, watchdogState: watchdog, ultramsgLive: ultramsg, confirmations });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
