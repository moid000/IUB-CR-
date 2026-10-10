import mongoose from 'mongoose';

/**
 * WASENDER ROSTER CACHE (2026-10-10): Wasender's group-participants endpoint
 * is rate-limited (trial 10 req/min, paid 10 req/min, 500/day) while the CR
 * group page needs the roster of EVERY group on every refresh. We therefore
 * persist each group's participant list with a fetchedAt stamp and re-use it
 * within a TTL, fetching only a bounded number of stale/missing rosters per
 * refresh call. Stale-but-present rosters also serve as a fallback when a
 * live fetch fails (rate limit / gateway hiccup) — the CR sees slightly old
 * data instead of an empty, misleading group list.
 */
const GroupRosterCacheSchema = new mongoose.Schema(
  {
    groupId: { type: String, required: true, unique: true, index: true },
    participants: { type: [String], default: [] },
    fetchedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

GroupRosterCacheSchema.index({ groupId: 1 }, { unique: true });

export default mongoose.models.GroupRosterCache
  ?? mongoose.model('GroupRosterCache', GroupRosterCacheSchema);
