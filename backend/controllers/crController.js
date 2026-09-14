import User from '../models/User.js';
import Section from '../models/Section.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import { assertName, assertEmail, assertPhone, pick } from '../utils/validators.js';
import { parsePagination, paginationMeta } from '../utils/pagination.js';
import * as subjectSvc from '../services/subjectService.js';
import announcementSvc from '../services/announcementService.js';
import noteSvc from '../services/noteService.js';
import * as assignmentSvc from '../services/assignmentService.js';
import * as timetableSvc from '../services/timetableService.js';
import * as attendanceSvc from '../services/attendanceService.js';

/**
 * CR student management. Section ownership is ALWAYS server-derived from
 * the authenticated CR (req.user.section, loaded fresh from MongoDB by
 * protect) — req.body.section is never read, never trusted.
 */

/**
 * Lists students ONLY in the CR's own current section, with safe pagination.
 */
export async function listStudents(req, res, next) {
  try {
    const sectionId = req.user.section; // server-derived
    if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');
    const { page, limit, skip } = parsePagination(req.query);
    const filter = { section: sectionId, role: 'student' };
    const [students, total] = await Promise.all([
      User.find(filter)
        .select('name email phone rollNo registrationStatus emailVerified createdAt')
        .sort({ rollNo: 1, createdAt: -1 })
        .skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);
    res.json({ success: true, data: students, pagination: paginationMeta(total, { page, limit }) });
  } catch (err) {
    next(err);
  }
}

/* ---- Subject management — ALWAYS scoped to req.user.section ---- */
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

export const listSubjects = wrapList(subjectSvc.listSubjectsCr);

/* ---- Announcements + Notes — ALWAYS scoped to req.user.section ---- */
export const listAnnouncements = wrapList(announcementSvc.listCr);
export const createAnnouncement = wrapDoc(announcementSvc.createCr);
export const getAnnouncement = wrapDoc(announcementSvc.getCr);
export const updateAnnouncement = wrapDoc(announcementSvc.updateCr);
export const archiveAnnouncement = wrapDoc(announcementSvc.archiveCr);

export const listNotes = wrapList(noteSvc.listCr);
export const createNote = wrapDoc(noteSvc.createCr);
export const getNote = wrapDoc(noteSvc.getCr);
export const updateNote = wrapDoc(noteSvc.updateCr);
export const archiveNote = wrapDoc(noteSvc.archiveCr);

/* ---- Assignments — ALWAYS scoped to req.user.section ---- */
export const listAssignments = wrapList(assignmentSvc.listAssignmentsCr);
export const createAssignment = wrapDoc(assignmentSvc.createAssignmentCr);
export const getAssignment = wrapDoc(assignmentSvc.getAssignmentCr);
export const updateAssignment = wrapDoc(assignmentSvc.updateAssignmentCr);
export const archiveAssignment = wrapDoc(assignmentSvc.archiveAssignmentCr);
export const listSubmissions = wrapList(assignmentSvc.listSubmissionsCr);
export const getSubmission = wrapDoc(assignmentSvc.getSubmissionCr);

/* ---- Timetable — section ALWAYS req.user.section; overlap enforced ---- */
export const listTimetable = wrapList(timetableSvc.listTimetableCr);
export const createTimetable = wrapDoc(timetableSvc.createTimetableCr);
export const getTimetable = wrapDoc(timetableSvc.getTimetableCr);
export const updateTimetable = wrapDoc(timetableSvc.updateTimetableCr);
export const archiveTimetable = wrapDoc(timetableSvc.archiveTimetableCr);

/* ---- Attendance — section ALWAYS req.user.section; code shown once at create ---- */
export const createAttendanceSession = wrapDoc(attendanceSvc.createSession);
export const listAttendanceSessions = wrapList(attendanceSvc.listSessionsCr);
export const getAttendanceSession = wrapDoc(attendanceSvc.getSessionCr);
export const cancelAttendanceSession = wrapDoc(attendanceSvc.cancelSession);
export const listAttendanceRecords = wrapList(attendanceSvc.listRecordsCr);
export const createSubject = wrapDoc(subjectSvc.createSubjectCr);
export const getSubject = wrapDoc(subjectSvc.getSubjectCr);
export const updateSubject = wrapDoc(subjectSvc.updateSubjectCr);
export const archiveSubject = wrapDoc(subjectSvc.archiveSubjectCr);

/**
 * Pre-creates a pending student INSIDE the CR's own section.
 * The client cannot choose: role, section, createdBy, registrationStatus,
 * emailVerified, or password — all server-controlled.
 */
export async function precreateStudent(req, res, next) {
  try {
    if (req.user.registrationStatus !== 'active') {
      throw new ApiError(403, 'Account is not active');
    }
    const sectionId = req.user.section; // server-derived — req.body.section ignored
    if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');

    const section = await Section.findById(sectionId);
    if (!section) throw new ApiError(400, 'Your section no longer exists');
    if (section.status !== 'active') throw new ApiError(400, 'Your section is archived');

    const body = pick(req.body, ['name', 'rollNo', 'email', 'phone']); // section deliberately NOT pickable
    const name = assertName(body.name, 'name');
    const email = assertEmail(body.email, 'email');
    const phone = assertPhone(body.phone, 'phone');
    const rollNo = String(body.rollNo ?? '').trim().toUpperCase();
    if (!rollNo || rollNo.length > 20) throw new ApiError(400, 'Invalid rollNo');

    const student = await User.create({
      name,
      email, // globally unique (11000 → 409)
      phone,
      rollNo, // unique within the section (11000 → 409)
      role: 'student',
      registrationStatus: 'pending',
      emailVerified: false,
      password: null,
      section: sectionId, // CR's own current section
      createdBy: req.user._id, // server-derived
    });

    await auditFromReq(req, {
      action: 'user.student.precreate', entityType: 'user',
      entityId: student._id, targetUser: student._id, section: sectionId,
      after: { name, email, rollNo, role: 'student', registrationStatus: 'pending', section: String(sectionId) },
    });
    res.json({ success: true, data: student });
  } catch (err) {
    next(err);
  }
}
