/**
 * Central API client — every frontend request goes through here.
 *
 * - credentials: "include" — auth uses the httpOnly `iub_auth` cookie.
 *   The JWT is NEVER read, stored, or handled by JavaScript.
 * - Errors are normalized into ApiError with a safe, user-friendly
 *   message. Backend internals / stack traces never surface.
 */

export class ApiError extends Error {
  constructor(status, message, code = null, fields = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // 0 = network failure
    this.code = code;
    this.fields = fields;
  }
  get isAuthMissing() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
  get isNotFound() { return this.status === 404; }
  get isConflict() { return this.status === 409; }
  get isRateLimited() { return this.status === 429; }
}

const FRIENDLY = {
  0: 'Unable to reach the server. Check your connection and try again.',
  400: 'That request was invalid. Please check your details and try again.',
  401: 'Please sign in to continue.',
  403: "You don't have permission to do that.",
  404: "That doesn't exist or is no longer available.",
  409: 'There is a conflict with the current state — please refresh and try again.',
  413: 'That upload is too large.',
  429: 'Too many requests — please wait a moment and try again.',
  500: 'Something went wrong on our side. Please try again.',
  502: 'The server is unavailable. Please try again shortly.',
  503: 'The server is temporarily unavailable. Please try again shortly.',
};

const sanitize = (message) =>
  typeof message === 'string' && message.length <= 200 && !/at .+\(.+:\d+:\d+\)/.test(message)
    ? message
    : null; // anything odd/stack-like is dropped

/**
 * Tiny in-memory GET cache — perceived-speed only, zero API/logic change.
 *
 * - A GET served within GET_FRESH_MS of its last success resolves
 *   instantly from memory (back-navigation / tab revisits feel instant).
 * - Identical GETs in flight share one network request.
 * - ANY mutation (POST/PUT/PATCH/DELETE) clears the whole cache, so data
 *   never stays stale after the user changes something.
 * - Auth endpoints are never cached; aborted requests bypass the cache.
 */
const GET_FRESH_MS = 8000;
const getCache = new Map(); // path -> { data, ts }
const inflight = new Map(); // path -> Promise<data>

function cacheClear() {
  getCache.clear();
  inflight.clear();
}

function cachedGet(path) {
  const hit = getCache.get(path);
  if (hit && Date.now() - hit.ts < GET_FRESH_MS) return hit.data;
  const existing = inflight.get(path);
  if (existing) return existing;
  const p = request(path).finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'include', // httpOnly cookie auth — always
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, FRIENDLY[0], 'network_error');
  }

  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null; // non-JSON — treated as opaque failure below
  }

  if (!res.ok) {
    const message = sanitize(data?.message) ?? FRIENDLY[res.status] ?? FRIENDLY[500];
    const fields = Array.isArray(data?.errors)
      ? Object.fromEntries(data.errors.map((e) => [e.field, e.message]))
      : null;
    throw new ApiError(res.status, message, data?.code ?? null, fields);
  }
  return data;
}

export const api = {
  get: (path, opts) =>
    // aborted or auth-session requests always hit the network
    (opts?.signal || path.startsWith('/api/auth'))
      ? request(path, opts)
      : cachedGet(path),
  post: (path, body, opts) => { cacheClear(); return request(path, { method: 'POST', body, ...opts }); },
  put: (path, body, opts) => { cacheClear(); return request(path, { method: 'PUT', body, ...opts }); },
  patch: (path, body, opts) => { cacheClear(); return request(path, { method: 'PATCH', body, ...opts }); },
  del: (path, opts) => { cacheClear(); return request(path, { method: 'DELETE', ...opts }); },
};
