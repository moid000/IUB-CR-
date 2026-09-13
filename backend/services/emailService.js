import { env } from '../config/env.js';
import { ApiError } from '../middleware/error.js';

/**
 * Brevo transactional email (HTTP API — never SMTP).
 * API key is read ONLY from the environment, never logged, never returned.
 */

const PURPOSE_SUBJECTS = {
  'cr-activation': 'Your CR activation code',
  'student-activation': 'Your student account activation code',
  'password-reset': 'Your password reset code',
};

function otpText(name, otp, purpose) {
  const what = purpose === 'password-reset'
    ? 'reset your password'
    : 'activate your account';
  return (
    `Hi ${name || 'there'},\n\n` +
    `Your verification code is: ${otp}\n\n` +
    `Use this code to ${what}. It expires in 10 minutes.\n\n` +
    `If you did not request this, you can ignore this email.\n\n` +
    `— IUB Class Management`
  );
}

/**
 * Sends a 6-digit OTP email via Brevo. Throws a SAFE 502 error on any
 * failure — Brevo internals, the API key, and the OTP are never exposed
 * or logged.
 */
export async function sendOtpEmail({ to, name, otp, purpose }) {
  if (!env.brevoApiKey || !env.brevoSenderEmail) {
    // Configuration problem — never a client-visible secret
    throw new ApiError(502, 'Email delivery is not configured');
  }
  const subject = PURPOSE_SUBJECTS[purpose] ?? 'Your verification code';

  let res;
  try {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.brevoApiKey, // never logged, never returned
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: env.brevoSenderName || 'IUB Class Manager', email: env.brevoSenderEmail },
        to: [{ email: to, name: name || to }],
        subject,
        textContent: otpText(name, otp, purpose),
      }),
    });
  } catch {
    // Network-level failure — no internals leaked
    throw new ApiError(502, 'Email delivery failed. Please try again.');
  }

  if (!res.ok) {
    // Log safe diagnostics ONLY: status + brevo error code, never the key or OTP
    let code = '';
    try {
      const body = await res.json();
      code = body?.code ?? body?.message ?? '';
    } catch { /* non-JSON body */ }
    console.error('[brevo] send failed:', res.status, String(code).slice(0, 120));
    throw new ApiError(502, 'Email delivery failed. Please try again.');
  }
  return true;
}
