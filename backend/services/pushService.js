import webpush from 'web-push';
import { PushSubscription } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { now } from '../utils/clock.js';

/**
 * Web Push (VAPID) delivery service.
 *
 * FREE by design: no FCM/APNs account needed — the app itself is the push
 * application server, keys are per-deployment VAPID keypair in env.
 *
 * RELIABILITY — sends are fire-and-forget from the caller's perspective:
 * delivery NEVER throws back into content-creation flows. Per-endpoint
 * failures are logged, and 404/410 (unsubscribed/expired) subscriptions are
 * deleted automatically. This keeps the table self-cleaning.
 */

const TTL_SECONDS = 24 * 60 * 60; // server-side retention for offline devices

let configured = null;

function vapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@iubcr.app';
  if (!publicKey || !privateKey) return null;
  if (!configured || configured.publicKey !== publicKey) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configured = { publicKey };
  }
  return { publicKey, privateKey };
}

export function getVapidPublicKey() {
  const v = vapid();
  if (!v) throw new ApiError(500, 'Push notifications are not configured on the server');
  return v.publicKey;
}

function assertSubscription(body) {
  const sub = body?.subscription ?? body;
  const endpoint = String(sub?.endpoint ?? '').trim();
  const p256dh = String(sub?.keys?.p256dh ?? '').trim();
  const auth = String(sub?.keys?.auth ?? '').trim();
  if (!/^https:\/\//.test(endpoint)) throw new ApiError(400, 'Subscription endpoint must be an https URL');
  if (!p256dh || !auth) throw new ApiError(400, 'Subscription keys (p256dh, auth) are required');
  return { endpoint, p256dh, auth };
}

/** Subscribe (upsert by endpoint) the CURRENT authenticated user's device. */
export async function subscribePush(req) {
  const { endpoint, p256dh, auth } = assertSubscription(req.body);
  await PushSubscription.updateOne(
    { endpoint },
    {
      $set: {
        user: req.user._id,
        endpoint,
        keys: { p256dh, auth },
        userAgent: req.get?.('user-agent'),
        lastError: null,
        lastSeenAt: new Date(now()),
      },
    },
    { upsert: true },
  );
  return { saved: true };
}

/** Remove a device — only if it belongs to the requesting user. */
export async function unsubscribePush(req) {
  const endpoint = String(req.body?.endpoint ?? '').trim();
  if (!/^https:\/\//.test(endpoint)) throw new ApiError(400, 'Subscription endpoint must be an https URL');
  const res = await PushSubscription.deleteOne({ endpoint, user: req.user._id });
  return { deleted: res.deletedCount > 0 };
}

/**
 * Send a push to every device of the given users. NEVER throws — content
 * creation must not fail because one device was offline. Returns a summary.
 * Payload: { title, body, url, tag } (tag collapses repeated notifications).
 */
export async function sendPushToUsers(userIds, { title, body, url, tag }) {
  const result = { sent: 0, failed: 0, removed: 0 };
  if (!userIds?.length) return result;
  if (!vapid()) return result; // push not configured — silent no-op
  if (!Array.isArray(userIds)) userIds = [userIds];
  const subs = await PushSubscription.find({ user: { $in: userIds } }).lean();
  if (!subs.length) return result;

  const payload = JSON.stringify({
    title: String(title ?? 'New notification').slice(0, 120),
    body: String(body ?? '').slice(0, 500),
    url: url ? String(url).slice(0, 300) : '/',
    tag: tag || 'tri3m',
  });

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload,
        { TTL: TTL_SECONDS, urgency: 'normal' },
      );
      result.sent += 1;
    } catch (err) {
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        // endpoint gone — clean up, ignore races (deleteOne is idempotent)
        await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
        result.removed += 1;
      } else {
        const msg = String(err?.body || err?.message || '').slice(0, 200);
        await PushSubscription.updateOne({ _id: sub._id }, { lastError: msg }).catch(() => {});
        result.failed += 1;
      }
    }
  }));
  return result;
}

/** Deep link for a notification — students and reps use different portals. */
export function pushUrlFor(type, role) {
  const portal = role === 'cr' || role === 'gr' ? 'cr' : 'student';
  switch (type) {
    case 'announcement': return `/${portal}/announcements`;
    case 'assignment': return `/${portal}/assignments`;
    case 'note': return `/${portal}/notes`;
    case 'timetable': return `/${portal}/timetable`;
    case 'reminder': return `/${portal}/assignments`;
    default: return `/${portal}`;
  }
}
