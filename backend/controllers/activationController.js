import * as activation from '../services/activationService.js';

/**
 * Public activation + password-reset endpoints. Every request/response is
 * shaped by the service layer; OTP codes and tokens appear ONLY in the
 * dedicated verify responses, never anywhere else.
 */
const wrap = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    next(err);
  }
};

// CR activation
export const crRequestOtp = wrap((req) => activation.requestActivationOtp('cr', req));
export const crVerifyOtp = wrap(async (req) => {
  const { activationToken, expiresIn } = await activation.verifyActivationOtp('cr', req);
  return { success: true, activationToken, expiresIn };
});
export const crSetPassword = wrap(async (req) => {
  await activation.setActivationPassword('cr', req);
  return { success: true, message: 'Account activated. You can now log in.' };
});

// Student activation
export const studentRequestOtp = wrap((req) => activation.requestActivationOtp('student', req));
export const studentVerifyOtp = wrap(async (req) => {
  const { activationToken, expiresIn } = await activation.verifyActivationOtp('student', req);
  return { success: true, activationToken, expiresIn };
});
export const studentSetPassword = wrap(async (req) => {
  await activation.setActivationPassword('student', req);
  return { success: true, message: 'Account activated. You can now log in.' };
});

// Password reset (active accounts)
export const resetRequestOtp = wrap(async (req) => {
  const { message } = await activation.requestPasswordResetOtp(req);
  return { success: true, message };
});
export const resetVerifyOtp = wrap(async (req) => {
  const { resetToken, expiresIn } = await activation.verifyPasswordResetOtp(req);
  return { success: true, resetToken, expiresIn };
});
export const resetSetPassword = wrap(async (req) => {
  await activation.setResetPassword(req);
  return { success: true, message: 'Password updated. You can now log in.' };
});
