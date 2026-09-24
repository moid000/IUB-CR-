import { Router } from 'express';
import crypto from 'crypto';
import { env } from '../config/env.js';

/** TEMPORARY one-shot Cloudinary QA-file wipe (removed right after use).
 * Scope: ONLY the iub-cr-lms/ upload namespace (all app uploads live there).
 * Guarded by TEMP_WIPE_SECRET; 404 otherwise. */

const router = Router();
const PREFIX = 'iub-cr-lms/';

const guarded = (req) => {
  const given = String(req.headers['x-wipe-secret'] ?? req.query.secret ?? '');
  return process.env.TEMP_WIPE_SECRET && given === process.env.TEMP_WIPE_SECRET;
};

async function adminApi(method, path, params = {}) {
  const url = new URL(`https://api.cloudinary.com/v1_1/${env.cloudinary.cloudName}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const auth = Buffer.from(`${env.cloudinary.apiKey}:${env.cloudinary.apiSecret}`).toString('base64');
  const res = await fetch(url, { method, headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Cloudinary ${res.status}: ${await res.text()}`);
  return res.json();
}

router.get('/cloud-counts', async (req, res) => {
  if (!guarded(req)) return res.status(404).json({ success: false, message: 'Not found' });
  try {
    let total = 0, cursor, samples = [];
    do {
      const d = await adminApi('GET', 'resources', { prefix: PREFIX, type: 'upload', max_results: 500, next_cursor: cursor });
      total += d.resources.length;
      samples.push(...d.resources.slice(0, 5).map((r) => r.public_id));
      cursor = d.next_cursor;
    } while (cursor);
    res.json({ success: true, cloud: env.cloudinary.cloudName, prefix: PREFIX, total, samples });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/cloud-wipe', async (req, res) => {
  if (!guarded(req)) return res.status(404).json({ success: false, message: 'Not found' });
  try {
    const d = await adminApi('DELETE', 'resources', { prefix: PREFIX, type: 'upload' });
    res.json({ success: true, cloud: env.cloudinary.cloudName, prefix: PREFIX, response: d });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
