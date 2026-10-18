import LlmUsage from '../models/LlmUsage.js';
import ChatbotLog from '../models/ChatbotLog.js';
import ChatbotSetting from '../models/ChatbotSetting.js';

/**
 * OWNER FEATURE 2026-10-18 — LLM TELEMETRY + ADMIN HEALTH SNAPSHOT.
 * recordLlm() is called at every provider call site (group chain, teacher
 * chat, material classification, Groq fallback) and is ALWAYS fire-and-forget:
 * it upserts atomically and can never slow or break a live reply.
 * llmHealthSnapshot() aggregates today's counters, the AI breaker state, the
 * reply-source distribution, and Groq's REAL rate-limit endpoint (cached
 * 5 minutes) for the Administration panel's model-health card.
 */

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // Asia/Karachi, UTC+5

/** Same breaker contract as chatbotService (kept private there): the
 * durable cooldown after a full Gemini-chain failure. */
async function getAiOutageUntil() {
  try {
    const d = await ChatbotSetting.findOne({ key: 'global' }).select('aiOutageUntil').lean();
    return d?.aiOutageUntil ? new Date(d.aiOutageUntil).getTime() : 0;
  } catch { return 0; }
}
export const pktDayKey = (ts = Date.now()) =>
  new Date(ts + PKT_OFFSET_MS).toISOString().slice(0, 10);

const errText = (status, error) => {
  if (status === 429) return '429 — daily/rate limit reached';
  if (status === 503) return '503 — provider overloaded (Google throttle)';
  if (status === 'timeout') return 'timeout — model did not answer in time';
  if (status === 'empty') return 'empty answer from the model';
  if (status === 'unparseable') return 'model answered but not in the required JSON format';
  const head = String(error ?? '').trim();
  return head ? `${status ?? 'error'} — ${head.slice(0, 220)}` : `${status ?? 'error'} — unknown error`;
};

/** Fire-and-forget per-call counter. NEVER throws, NEVER blocks. */
export function recordLlm({ provider, model, ok = false, status = null, error = '' }) {
  const modelId = String(model ?? '').slice(0, 80);
  if (!modelId) return;
  const day = pktDayKey();
  const update = {
    $inc: { calls: 1, [ok ? 'ok' : status === 429 ? 'fail429' : 'failOther']: 1 },
  };
  if (!ok) update.$set = { lastError: errText(status, error).slice(0, 300), lastErrorAt: new Date() };
  LlmUsage.updateOne({ day, provider, model: modelId }, update, { upsert: true })
    .catch(() => { /* telemetry must never break the pipeline */ });
}

/* ------------------------- Groq rate limits ------------------------------ */

const GROQ_RATE_URL = 'https://api.groq.com/openai/v1/rate_limits';
let groqCache = { at: 0, data: null }; // module cache — serverless instances share per warm container

/** Groq exposes REAL remaining limits on its rate-limits endpoint. Mapped
 * defensively: any shape change degrades to nulls, never to lies. */
export async function groqRateLimits(key, models = []) {
  if (!key) return null;
  if (groqCache.data && Date.now() - groqCache.at < 5 * 60 * 1000) return groqCache.data;
  try {
    const qs = models.length ? `?models=${encodeURIComponent(models.join(','))}` : '';
    const res = await fetch(`${GROQ_RATE_URL}${qs}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const rows = Array.isArray(json?.data) ? json.data : [];
    const data = rows.map((r) => ({
      model: String(r?.id ?? ''),
      requestsPerDay: r?.rate_limits?.rpdl ?? r?.requests_per_day ?? null,
      remainingRequests: r?.rate_limits?.remaining_rpdl ?? r?.remaining_requests_per_day ?? null,
      tokensPerDay: r?.rate_limits?.tpd ?? r?.tokens_per_day ?? null,
      remainingTokens: r?.rate_limits?.remaining_tpd ?? r?.remaining_tokens_per_day ?? null,
    })).filter((r) => r.model);
    groqCache = { at: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

/* ------------------------- health snapshot ------------------------------ */

/** Everything the Administration panel's model-health card needs. */
export async function llmHealthSnapshot({ groqKey = '', groqModels = [] } = {}) {
  const day = pktDayKey();
  const [rows, outageUntil, sources, groqLimits] = await Promise.all([
    LlmUsage.find({ day }).sort({ provider: 1, model: 1 }).lean(),
    getAiOutageUntil(),
    ChatbotLog.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
    groqRateLimits(groqKey, groqModels).catch(() => null),
  ]);

  const sourceMap = {};
  let total = 0;
  for (const { _id, count } of sources) { sourceMap[_id ?? 'unknown'] = count; total += count; }

  return {
    day,
    aiOutageUntil: outageUntil && new Date(outageUntil).getTime() > Date.now() ? outageUntil : null,
    breakerOpen: Boolean(outageUntil && new Date(outageUntil).getTime() > Date.now()),
    replies24h: { total, bySource: sourceMap },
    models: rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      calls: r.calls ?? 0,
      ok: r.ok ?? 0,
      fail429: r.fail429 ?? 0,
      failOther: r.failOther ?? 0,
      lastError: r.lastError ?? '',
      lastErrorAt: r.lastErrorAt ?? null,
    })),
    groqLimits: groqLimits ?? [],
    note: 'Usage counters cover the chat pipeline (group bot, teacher chat, material classification). Groq remaining limits come live from Groq\'s rate-limits API; Google does not expose remaining quota, so Gemini shows our own usage counters plus the exact failure reason per model.',
  };
}
