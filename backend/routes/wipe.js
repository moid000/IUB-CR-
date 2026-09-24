import { Router } from 'express';
import mongoose from 'mongoose';

/** TEMPORARY one-shot production data wipe (removed right after use).
 * Guarded by TEMP_WIPE_SECRET only; returns 404 like a missing route otherwise.
 * Wipes ALL user/test data; keeps watchdogstates (UltraMsg uptime bookkeeping). */
const router = Router();
const KEPT = new Set(['watchdogstates', 'system.users', 'system.sessions', 'system.js', 'system.views', 'system.version', 'system.newmultiphase', 'local.replset.minvalid', 'startup_log', 'fs.chunks', 'fs.files']);


router.all('/wipe-prod-data', async (req, res) => {
  const given = String(req.headers['x-wipe-secret'] ?? req.query.secret ?? '');
  if (!process.env.TEMP_WIPE_SECRET || given !== process.env.TEMP_WIPE_SECRET) return res.status(404).json({ success: false, message: 'Not found' });
  const db = mongoose.connection.db;
  const names = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => !KEPT.has(n));
  const report = {};
  for (const name of names) {
    const { deletedCount } = await db.collection(name).deleteMany({});
    report[name] = deletedCount;
  }
  res.json({ success: true, wiped: report, total: Object.values(report).reduce((a, b) => a + b, 0) });
});

router.get('/wipe-prod-counts', async (req, res) => {
  const given = String(req.headers['x-wipe-secret'] ?? req.query.secret ?? '');
  if (!process.env.TEMP_WIPE_SECRET || given !== process.env.TEMP_WIPE_SECRET) return res.status(404).json({ success: false, message: 'Not found' });
  const db = mongoose.connection.db;
  const out = {};
  for (const c of (await db.listCollections().toArray()).map((c) => c.name)) {
    if (!KEPT.has(c)) out[c] = await db.collection(c).countDocuments();
  }
  out['watchdogstates(kept)'] = await db.collection('watchdogstates').countDocuments().catch(() => 0);
  res.json({ success: true, counts: out });
});

export default router;
