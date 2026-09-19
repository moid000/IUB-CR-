import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/**
 * Web Push (VAPID) subscription — one browser/device per user.
 *
 * TRUST MODEL — subscriptions are created ONLY by the authenticated owner
 * of the subscription: the user id comes from req.user, never from the body.
 * The endpoint is globally unique (browser-guaranteed), so re-subscribing
 * from the same browser upserts in place; a user may hold several devices.
 * Dead subscriptions (410/404 on send) are removed by the push service —
 * the index below makes that removal cheap and idempotent.
 */
const pushSubscriptionSchema = new Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true, trim: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, trim: true },
    lastError: { type: String, trim: true },
    lastSeenAt: { type: Date },
  },
  { timestamps: true },
);

export default mongoose.models.PushSubscription
  || mongoose.model('PushSubscription', pushSubscriptionSchema);
