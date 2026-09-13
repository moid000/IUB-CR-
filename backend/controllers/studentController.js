import announcementSvc from '../services/announcementService.js';
import noteSvc from '../services/noteService.js';

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
