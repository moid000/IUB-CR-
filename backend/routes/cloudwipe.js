import { Router } from 'express';
import { env } from '../config/env.js';
import { destroyAsset } from '../services/fileService.js';

/** TEMPORARY one-shot Cloudinary QA-file wipe (removed right after use).
 * Scope: ONLY the iub-cr-lms/ upload namespace. Guarded by TEMP_WIPE_SECRET. */

const router = Router();
const PREFIX = 'iub-cr-lms/';
const TYPES = ['image', 'video', 'raw'];

const guarded = (req) => {
  const given = String(req.headers['x-wipe-secret'] ?? req.query.secret ?? '');
  return process.env.TEMP_WIPE_SECRET && given === process.env.TEMP_WIPE_SECRET;
};

async function adminApi(method, path, params = {}) {
  const url = new URL(`https://api.cloudinary.com/v1_1/${env.cloudinary.cloudName}/${path}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const auth = Buffer.from(`${env.cloudinary.apiKey}:${env.cloudinary.apiSecret}`).toString('base64');
  const res = await fetch(url, { method, headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Cloudinary ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function listAll(rt) {
  let total = 0, cursor, samples = [];
  do {
    const d = await adminApi('GET', `resources/${rt}/upload`, { prefix: PREFIX, max_results: 500, next_cursor: cursor });
    const rs = d.resources ?? [];
    total += rs.length;
    samples.push(...rs.slice(0, 3).map((r) => r.public_id));
    cursor = d.next_cursor;
  } while (cursor);
  return { total, samples };
}

router.get('/cloud-counts', async (req, res) => {
  if (!guarded(req)) return res.status(404).json({ success: false, message: 'Not found' });
  try {
    const out = {};
    for (const rt of TYPES) out[rt] = await listAll(rt);
    res.json({ success: true, cloud: env.cloudinary.cloudName, prefix: PREFIX, counts: out });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/cloud-wipe', async (req, res) => {
  if (!guarded(req)) return res.status(404).json({ success: false, message: 'Not found' });
  try {
    const out = {};
    for (const rt of TYPES) {
      let destroyed = 0, failed = 0;
      // collect all public_ids under the namespace
      let ids = [], cursor;
      do {
        const d = await adminApi('GET', `resources/${rt}/upload`, { prefix: PREFIX, max_results: 500, next_cursor: cursor });
        ids.push(...(d.resources ?? []).map((r) => r.public_id));
        cursor = d.next_cursor;
      } while (cursor);
      for (const id of ids) {
        try {
          const r = await destroyAsset({ cloudName: env.cloudinary.cloudName, apiKey: env.cloudinary.apiKey, apiSecret: env.cloudinary.apiSecret, publicId: id, resourceType: rt });
          const j = await r.json();
          if (j.result === 'ok' || j.result === 'not found') destroyed++; else failed++;
        } catch { failed++; }
      }
      out[rt] = { found: ids.length, destroyed, failed };
    }
    const verify = {};
    for (const rt of TYPES) verify[rt] = (await listAll(rt)).total;
    res.json({ success: true, prefix: PREFIX, result: out, remaining: verify });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
