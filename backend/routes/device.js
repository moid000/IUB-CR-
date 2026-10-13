/**
 * Device-facing routes — NO user auth: the device proves itself with an
 * HMAC signature over (deviceId|ts|nonce|body) using a key derived from
 * its one-time secret (see services/deviceAttendanceService.js header).
 *
 * These routes are deliberately separate from /api/cr/* and /api/admin/*:
 * an attacker with a stolen cookie gains nothing here, and a stolen device
 * secret grants nothing in the portals.
 */
import { Router } from 'express';

const router = Router();

const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res)).then((data) => res.json({ ok: true, data }))
    .catch(next);
};
// device replies carry their own {ok,...} shape (the firmware parses it
// directly); successful HTTP status is implied, failures use the normal
// error handler (401/400/403 JSON the firmware treats as retryable/abort).
const wrapRaw = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res)).then((data) => {
    if (data && typeof data === 'object' && 'ok' in data) return res.json(data);
    res.json({ ok: true, data });
  }).catch(next);
};

const {
  deviceHeartbeat, deviceScan, deviceEnroll,
} = await import('../services/deviceAttendanceService.js');

router.post('/heartbeat', wrapRaw(deviceHeartbeat));
router.post('/scan', wrapRaw(deviceScan));
router.post('/enroll', wrapRaw(deviceEnroll));

export default router;
