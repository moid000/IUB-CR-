import * as svc from '../services/adminService.js';

/**
 * Admin API — every route sits behind protect + adminOnly (see routes/admin.js).
 * Services own validation, transactions, and audit logging; the controller
 * only shapes responses.
 */
const wrap = (fn) => async (req, res, next) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (err) {
    next(err);
  }
};

export const createDepartment = wrap(svc.createDepartment);
export const listDepartments = wrap(svc.listDepartments);
export const updateDepartment = wrap(svc.updateDepartment);
export const archiveDepartment = wrap(svc.archiveDepartment);

export const createSession = wrap(svc.createSession);
export const listSessions = wrap(svc.listSessions);
export const updateSession = wrap(svc.updateSession);
export const archiveSession = wrap(svc.archiveSession);

export const createSection = wrap(svc.createSection);
export const listSections = wrap(svc.listSections);
export const getSection = wrap(svc.getSection);
export const updateSection = wrap(svc.updateSection);
export const archiveSection = wrap(svc.archiveSection);
export const assignCr = wrap(svc.assignCr);

export const precreateCr = wrap(svc.precreateCr);
