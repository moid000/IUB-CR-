import * as svc from '../services/adminService.js';
import * as subjectSvc from '../services/subjectService.js';
import announcementSvc from '../services/announcementService.js';
import noteSvc from '../services/noteService.js';
import * as assignmentSvc from '../services/assignmentService.js';
import * as timetableSvc from '../services/timetableService.js';

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

// Announcements (admin — any active section, explicitly)
export const createAnnouncementAdmin = wrap(announcementSvc.createAdmin);
export const listAnnouncementsAdmin = wrapList(announcementSvc.listAdmin);
export const getAnnouncementAdmin = wrap(announcementSvc.getAdmin);
export const updateAnnouncementAdmin = wrap(announcementSvc.updateAdmin);
export const archiveAnnouncementAdmin = wrap(announcementSvc.archiveAdmin);

// Assignments + submissions (admin — cross-section, read-only on submissions)
export const createAssignmentAdmin = wrap(assignmentSvc.createAssignmentAdmin);
export const listAssignmentsAdmin = wrapList(assignmentSvc.listAssignmentsAdmin);
export const getAssignmentAdmin = wrap(assignmentSvc.getAssignmentAdmin);
export const updateAssignmentAdmin = wrap(assignmentSvc.updateAssignmentAdmin);
export const archiveAssignmentAdmin = wrap(assignmentSvc.archiveAssignmentAdmin);
export const listSubmissionsAdmin = wrapList(assignmentSvc.listSubmissionsAdmin);
export const getSubmissionAdmin = wrap(assignmentSvc.getSubmissionAdmin);

// Timetable — cross-section admin access; section/subject relationship always validated
export const createTimetable = wrap(timetableSvc.createTimetableAdmin);
export const listTimetable = wrapList(timetableSvc.listTimetableAdmin);
export const getTimetable = wrap(timetableSvc.getTimetableAdmin);
export const updateTimetable = wrap(timetableSvc.updateTimetableAdmin);
export const archiveTimetable = wrap(timetableSvc.archiveTimetableAdmin);

// Notes (admin — any active section, explicitly)
export const createNoteAdmin = wrap(noteSvc.createAdmin);
export const listNotesAdmin = wrapList(noteSvc.listAdmin);
export const getNoteAdmin = wrap(noteSvc.getAdmin);
export const updateNoteAdmin = wrap(noteSvc.updateAdmin);
export const archiveNoteAdmin = wrap(noteSvc.archiveAdmin);

export const precreateCr = wrap(svc.precreateCr);
