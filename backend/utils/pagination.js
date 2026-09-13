/**
 * Safe pagination for every list endpoint.
 *
 * - page/limit must be positive integers; anything else falls back to defaults
 *   (no 500s on garbage input, no arbitrary query operators ever reach Mongo).
 * - limit is HARD-CAPPED at 100 so a client can never request unbounded data.
 */
const MAX_LIMIT = 100;

export function parsePagination(query = {}, defaults = {}) {
  let page = Number.parseInt(query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;

  let limit = Number.parseInt(query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1) limit = defaults.limit ?? 20;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  return { page, limit, skip: (page - 1) * limit, maxLimit: MAX_LIMIT };
}

export function paginationMeta(total, { page, limit }) {
  return {
    page,
    limit,
    maxLimit: MAX_LIMIT,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

/**
 * Controlled search: user input is regex-escaped and applied ONLY to the
 * explicitly allowed fields — never a raw client regex, never Mongo operators.
 */
export function searchFilter(term, fields) {
  const q = String(term ?? '').trim();
  if (!q) return null;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { $or: fields.map((f) => ({ [f]: new RegExp(escaped, 'i') })) };
}
