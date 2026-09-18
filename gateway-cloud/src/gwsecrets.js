/**
 * Auth helpers shared by the serverless handlers.
 * Secrets come from Vercel env vars (set once, never in code).
 */
export function authed(req, secretName) {
  const secret = process.env[secretName] || '';
  if (!secret) return false;
  const key = req.query?.key || new URL(req.url, 'http://x').searchParams.get('key') || '';
  const header = req.headers?.authorization || '';
  return key === secret || header === `Bearer ${secret}`;
}

export function unauthorized(res) {
  res.statusCode = 401;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
}

/** Normalize a PK mobile number to international digits (92301…). */
export function normalizePk(numberish) {
  let digits = String(numberish || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = `92${digits.slice(1)}`;
  if (digits.length === 10) digits = `92${digits}`;
  if (!/^92\d{10}$/.test(digits)) return null;
  return digits;
}
