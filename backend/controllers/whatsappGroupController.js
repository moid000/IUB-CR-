import * as groupSvc from '../services/whatsappGroupService.js';

/**
 * CR/GR WhatsApp group configuration — thin wrappers around the
 * section-scoped service. Section ownership is ALWAYS server-derived
 * (req.user.section); students can never reach these routes.
 */
const wrapDoc = (fn) => async (req, res, next) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (err) {
    next(err);
  }
};

export const getWhatsappGroup = wrapDoc(groupSvc.getGroupConfigCr);
export const refreshWhatsappGroups = wrapDoc(groupSvc.refreshGroupsCr);
export const linkWhatsappGroup = wrapDoc(groupSvc.linkGroupCr);
export const unlinkWhatsappGroup = wrapDoc(groupSvc.unlinkGroupCr);
