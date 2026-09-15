import * as gradingSvc from '../services/gradingService.js';

/**
 * Grading/Marks controllers — thin wrappers. Every ownership, lifecycle and
 * validation decision lives in the service and is derived server-side.
 */

const wrap = (fn) => async (req, res, next) => {
  try {
    const data = await fn(req);
    if (data?.items !== undefined) {
      const { items, pagination, ...rest } = data;
      return res.json({ success: true, data: items, ...(pagination ? { pagination } : {}), ...rest });
    }
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createAssessment = wrap(gradingSvc.createAssessment);
export const listAssessmentsCr = wrap(gradingSvc.listAssessmentsCr);
export const listAssessmentsAdmin = wrap(gradingSvc.listAssessmentsAdmin);
export const listAssessmentsStudent = wrap(gradingSvc.listAssessmentsStudent);
export const getAssessmentCr = wrap(gradingSvc.getAssessmentCr);
export const getAssessmentAdmin = wrap(gradingSvc.getAssessmentAdmin);
export const getAssessmentStudent = wrap(gradingSvc.getAssessmentStudent);
export const updateAssessment = wrap(gradingSvc.updateAssessment);
export const openAssessment = wrap(gradingSvc.openAssessment);
export const finalizeAssessment = wrap(gradingSvc.finalizeAssessment);
export const archiveAssessment = wrap(gradingSvc.archiveAssessment);
export const deleteAssessment = wrap(gradingSvc.deleteAssessment);
export const createMark = wrap(gradingSvc.createMark);
export const updateMark = wrap(gradingSvc.updateMark);
export const bulkUpsertMarks = wrap(gradingSvc.bulkUpsertMarks);
// listMarks returns ONE composite object ({ assessment, items, missing, counts }) —
// it is not a paginated list, so the generic wrap must not spread it.
export const listMarks = async (req, res, next) => {
  try {
    res.json({ success: true, data: await gradingSvc.listMarks(req) });
  } catch (err) { next(err); }
};
export const listMyMarks = wrap(gradingSvc.listMyMarks);
