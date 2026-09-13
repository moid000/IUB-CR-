import User from '../models/User.js';
import Section from '../models/Section.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import { assertName, assertEmail, assertPhone, pick } from '../utils/validators.js';

/**
 * CR student management. Section ownership is ALWAYS server-derived from
 * the authenticated CR (req.user.section, loaded fresh from MongoDB by
 * protect) — req.body.section is never read, never trusted.
 */

/**
 * Lists students ONLY in the CR's own current section.
 */
export async function listStudents(req, res, next) {
  try {
    const sectionId = req.user.section; // server-derived
    if (!sectionId) throw new ApiError(400, 'You are not assigned to a section');
    const students = await User.find({ section: sectionId, role: 'student' })
      .select('name email phone rollNo registrationStatus emailVerified createdAt')
      .sort({ rollNo: 1, createdAt: -1 });
    res.json({ success: true, data: students });
  } catch (err) {
    next(err);
  }
}

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
