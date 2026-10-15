/**
 * OWNER FEATURE 2026-10-15 (24/7 uptime): GROQ FREE-TIER FALLBACK.
 * Gemini stays PRIMARY — when the whole Gemini chain dies (daily quota /
 * datacenter throttling), Groq's free Llama models answer the SAME prompt
 * so the bot never pauses while free capacity exists anywhere.
 *
 * Design rules (owner spec):
 * - Same SYSTEM_PROMPT/personality/JSON contract as Gemini — Groq is a
 *   provider swap, never a different personality.
 * - Panel key (ChatbotSetting.groqApiKey) wins; env GROQ_API_KEY is the
 *   fallback. The key is NEVER returned by any API, log or WhatsApp send.
 * - NEVER throws; returns null on any failure so callers keep their own
 *   honest fallbacks.
 * - Bounded: single pass over the model chain, no retry storms.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// llama-3.3-70b: best quality free model; 8b-instant: fast quota headroom.
const GROQ_MODELS = (process.env.GROQ_MODELS || 'llama-3.3-70b-versatile,llama-3.1-8b-instant')
  .split(',').map((m) => m.trim()).filter(Boolean);

/** Tolerant JSON parse — mirrors parseGeminiJson (fences, embedded JSON). */
function parseLooseJson(text) {
  let raw = String(text ?? '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  if (fence) raw = fence[1];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/** Panel Groq key first, then env. Returns '' when unset. NEVER logs it. */
export async function runtimeGroqKey() {
  try {
    const { default: mongoose } = await import('mongoose');
    const ChatbotSetting = mongoose.models.ChatbotSetting;
    if (ChatbotSetting) {
      const doc = await ChatbotSetting.findOne({ key: 'global' }).select('groqApiKey').lean();
      const panel = String(doc?.groqApiKey ?? '').trim();
      if (panel) return panel;
    }
  } catch { /* fall through to env */ }
  return String(process.env.GROQ_API_KEY ?? '').trim();
}

/**
 * OpenAI-compatible chat call to Groq with a bounded model chain.
 * @param {object} opts { key, messages, jsonMode, temperature, maxTokens, timeoutMs, models }
 * @returns parsed JSON when jsonMode, raw text string otherwise, or null.
 */
export async function groqChat({ key, messages, jsonMode = true, temperature = 0.5,
  maxTokens = 900, timeoutMs = 6_000, models = GROQ_MODELS }) {
  if (!key) return null;
  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      // 429 quota / 4xx key / 5xx → next model. Groq free tier 429s are
      // per-model just like Google — the next model may still be alive.
      if (!res.ok) continue;
      const json = await res.json();
      const text = String(json?.choices?.[0]?.message?.content ?? '').trim();
      if (!text) continue;
      if (!jsonMode) return text;
      const parsed = parseLooseJson(text);
      if (parsed) return parsed;
    } catch { /* timeout/network → next model */ } finally { clearTimeout(timer); }
  }
  return null;
}

/**
 * Convert a Gemini-native payload (systemInstruction/contents/generationConfig
 * responseSchema) to OpenAI chat messages — lets the TEACHER flows reuse the
 * exact same prompts on Groq without rewriting them.
 */
export function geminiToOpenAi(payload) {
  const sys = (payload?.systemInstruction?.parts ?? []).map((p) => String(p?.text ?? '')).join('\n').trim();
  const messages = [];
  if (sys) messages.push({ role: 'system', content: sys });
  for (const turn of payload?.contents ?? []) {
    const text = (turn?.parts ?? []).map((p) => String(p?.text ?? '')).join('');
    if (!text) continue;
    messages.push({ role: turn?.role === 'model' ? 'assistant' : 'user', content: text });
  }
  return messages;
}

/**
 * Teacher-flow drop-in: run a Gemini payload on Groq (JSON contract preserved).
 * Returns the same shape geminiJson returns (parsed object or null).
 */
export async function groqFromGeminiPayload(payload, timeoutMs = 6_000) {
  const key = await runtimeGroqKey();
  if (!key) return null;
  const jsonMode = Boolean(payload?.generationConfig?.responseMimeType === 'application/json'
    || payload?.generationConfig?.responseSchema);
  const messages = geminiToOpenAi(payload);
  if (!messages.length) return null;
  return groqChat({ key, messages, jsonMode,
    temperature: typeof payload?.generationConfig?.temperature === 'number' ? payload.generationConfig.temperature : 0.5,
    maxTokens: Math.min(payload?.generationConfig?.maxOutputTokens ?? 900, 4_000),
    timeoutMs: Math.min(timeoutMs, 8_000) });
}
