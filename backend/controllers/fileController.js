import * as fileSvc from '../services/fileService.js';

/**
 * Cloudinary upload endpoints. Both are thin wrappers: every authorization
 * and verification decision lives in the service, derived from req.user and
 * the server-loaded parent document — never from client input.
 */

const wrap = (fn) => async (req, res, next) => {
  try {
    const data = await fn(req);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const signFileUpload = wrap(fileSvc.signUpload);
export const confirmFileUpload = wrap(fileSvc.confirmUpload);
export const removeFileUpload = wrap(fileSvc.removeAttachment);
export const signAvatarUpload = wrap(fileSvc.signAvatarUpload);
export const confirmAvatarUpload = wrap(fileSvc.confirmAvatarUpload);
export const removeAvatar = wrap(fileSvc.removeAvatar);
