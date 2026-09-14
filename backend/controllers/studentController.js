import announcementSvc from '../services/announcementService.js';
import noteSvc from '../services/noteService.js';
import * as assignmentSvc from '../services/assignmentService.js';
import * as timetableSvc from '../services/timetableService.js';
import * as attendanceSvc from '../services/attendanceService.js';

/**
 * Student API — strictly READ-ONLY (protect + studentOnly + sectionScope in
 * routes/student.js). No student mutation route exists in any phase.
 */
const wrapList = (fn) => async (req, res, next) => {
  try {
    const { items, pagination } = await fn(req);
    res.json({ success: true, data: items, pagination });
  } catch (err) {
    next(err);
  }
};
const wrapDoc = (fn) => async (req, res, next) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (err) {
    next(err);
  }
};

export const listAnnouncements = wrapList(announcementSvc.listStudent);
export const getAnnouncement = wrapDoc(announcementSvc.getStudent);
export const listNotes = wrapList(noteSvc.listStudent);
export const getNote = wrapDoc(noteSvc.getStudent);

/* ---- Assignments + own submission — section always server-derived ---- */
export const listAssignments = wrapList(assignmentSvc.listAssignmentsStudent);
export const getAssignment = wrapDoc(assignmentSvc.getAssignmentStudent);
export const submitSubmission = wrapDoc(assignmentSvc.submitSubmission);
export const getMySubmission = wrapDoc(assignmentSvc.getMySubmission);

/* ---- Timetable — read-only, section always server-derived ---- */
export const listTimetable = wrapList(timetableSvc.listTimetableStudent);
export const getTimetable = wrapDoc(timetableSvc.getTimetableStudent);

/* ---- Attendance — one path for code/QR; own records only ---- */
export const attendWithCode = wrapDoc(attendanceSvc.attendWithCode);
export const attendWithQr = wrapDoc(attendanceSvc.attendWithQr);
export const listMyAttendance = wrapList(attendanceSvc.listMyAttendance);
export const listSessionsStudent = wrapList(attendanceSvc.listSessionsStudent);
