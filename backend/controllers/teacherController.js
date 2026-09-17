import * as teacherSvc from '../services/teacherService.js';

/**
 * CR/GR teacher management — thin wrappers around the section-scoped service.
 * Section ownership is ALWAYS server-derived (req.user.section).
 */
const wrapDoc = (fn) => async (req, res, next) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (err) {
    next(err);
  }
};
const wrapList = (fn) => async (req, res, next) => {
  try {
    const { items, pagination } = await fn(req);
    res.json({ success: true, data: items, pagination });
  } catch (err) {
    next(err);
  }
};

export const listTeachers = wrapList(teacherSvc.listTeachersCr);
export const createTeacher = wrapDoc(teacherSvc.createTeacherCr);
export const updateTeacher = wrapDoc(teacherSvc.updateTeacherCr);
export const deleteTeacher = wrapDoc(teacherSvc.deleteTeacherCr);
