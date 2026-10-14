import { Router } from 'express';
import healthRoutes from './health.js';
import ClientError from '../models/ClientError.js';

const router = Router();

router.use('/health', healthRoutes);

/**
 * CLIENT-ERROR BEACON (2026-10-14 owner incident: Administration page hits
 * the "This page couldn't load" boundary card on his device; no reproduction
 * with realistic data on the server — the real error was invisible).
 * The frontend error boundaries POST the sanitized crash head here
 * (keepalive fetch, fire-and-forget). Public on purpose: a page that is
 * crashing may not have auth context — but heavily rate-limited, capped,
 * and PII-free: message/stack/component heads only, no user identifiers.
 */
const BEACON_HITS = new Map(); // ip -> { n, resetAt }
const LIMIT = 30; // per window per IP
const WINDOW_MS = 10 * 60 * 1000;

function beaconAllowed(ip) {
  const now = Date.now();
  const hit = BEACON_HITS.get(ip);
  if (!hit || now > hit.resetAt) {
    BEACON_HITS.set(ip, { n: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  hit.n += 1;
  return hit.n <= LIMIT;
}

function head(value, max = 300) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : '';
}

router.post('/client-error', async (req, res, next) => {
  try {
    const ip = req.ip || 'unknown';
    if (!beaconAllowed(ip)) return res.status(429).json({ success: false });
    const b = req.body ?? {};
    await ClientError.create({
      kind: ['page', 'root', 'preload'].includes(b.kind) ? b.kind : 'page',
      message: head(b.message),
      stackHead: head(b.stack),
      componentHead: head(b.componentStack),
      path: head(b.path, 200),
      userAgent: head(req.get('user-agent'), 200),
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
