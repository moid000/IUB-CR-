import * as svc from '../services/adminService.js';
import * as subjectSvc from '../services/subjectService.js';

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

/** List endpoints: services return { items, pagination } — data stays the array. */
const wrapList = (fn) => async (req, res, next) => {
  try {
    const { items, pagination } = await fn(req);
    res.json({ success: true, data: items, pagination });
  } catch (err) {
    next(err);
  }
};

export const createDepartment = wrap(svc.createDepartment);
export const listDepartments = wrap(svc.listDepartments);
export const getDepartment = wrap(svc.getDepartment);
export const updateDepartment = wrap(svc.updateDepartment);
export const archiveDepartment = wrap(svc.archiveDepartment);

export const createSession = wrap(svc.createSession);
export const listSessions = wrap(svc.listSessions);
export const getSession = wrap(svc.getSession);
export const updateSession = wrap(svc.updateSession);
export const archiveSession = wrap(svc.archiveSession);

export const createSection = wrap(svc.createSection);
export const listSections = wrap(svc.listSections);
export const getSection = wrap(svc.getSection);
export const updateSection = wrap(svc.updateSection);
export const archiveSection = wrap(svc.archiveSection);
export const assignCr = wrap(svc.assignCr);
export const reassignCr = wrap(svc.reassignCr);
export const removeCr = wrap(svc.removeCr);
export const listStudentsAdmin = wrapList(svc.listStudentsAdmin);

// Subjects (admin — any active section, explicitly)
export const createSubjectAdmin = wrap(subjectSvc.createSubjectAdmin);
export const listSubjectsAdmin = wrapList(subjectSvc.listSubjectsAdmin);
export const getSubjectAdmin = wrap(subjectSvc.getSubjectAdmin);
export const updateSubjectAdmin = wrap(subjectSvc.updateSubjectAdmin);
export const archiveSubjectAdmin = wrap(subjectSvc.archiveSubjectAdmin);

export const precreateCr = wrap(svc.precreateCr);
