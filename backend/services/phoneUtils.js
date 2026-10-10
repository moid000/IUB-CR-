/**
 * PK phone utilities (2026-10-11 CR-escalation fix).
 *
 * PROVEN ROOT CAUSE (live DB + Wasender docs): the portal stores phones in
 * LOCAL format (CR = '03088787753'), but (a) Wasender REQUIRES E.164 for
 * outbound 'to' ('923088787753') — every CR dispatch failed and burned
 * bounded attempts; (b) INBOUND sender digits always arrive E.164, so
 * local-format stored phones never matched — CR replies fell through to
 * the teacher flows (misclassified). Every CR/GR send and identity compare
 * must normalize. Storage stays untouched; this is format-tolerant logic.
 */
export function digitsOf(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

/** Pakistan E.164: '03088787753' -> '923088787753'. Unknown formats pass
 * through as digits (best effort, never invented). */
export function normalizePhone(phone) {
  const d = digitsOf(phone);
  if (/^92\d{10}$/.test(d)) return d; // already E.164
  if (/^0\d{10}$/.test(d)) return '92' + d.slice(1); // local, leading 0
  if (/^3\d{9}$/.test(d)) return '92' + d; // 10 digits, no country code
  return d;
}

/** Identity match for PK mobiles: same last-10 digits = same person. */
export function samePhone(a, b) {
  const da = digitsOf(a);
  const db = digitsOf(b);
  return Boolean(da) && Boolean(db) && da.length >= 10 && db.length >= 10
    && da.slice(-10) === db.slice(-10);
}
