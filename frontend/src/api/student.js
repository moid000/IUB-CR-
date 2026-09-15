/**
 * Student API layer — thin wrappers over the EXACT backend contracts.
 * Every route is scoped SERVER-SIDE to the authenticated student and their
 * current section; the frontend NEVER sends role/section/ownership fields.
 */
import { api } from './client.js';

const qs = (params = {}) => {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 'all')
  );
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
};

export const studentApi = {
  /* ---- Subjects (own section, active only — server-derived) ---- */
  subjects: {
    list: (params) => api.get(`/api/student/subjects${qs(params)}`), // page | limit → { data, pagination }
  },

  /* ---- Announcements (read-only) ---- */
  announcements: {
    list: (params) => api.get(`/api/student/announcements${qs(params)}`),
    get: (id) => api.get(`/api/student/announcements/${id}`),
  },

  /* ---- Notes (read-only) ---- */
  notes: {
    list: (params) => api.get(`/api/student/notes${qs(params)}`),
    get: (id) => api.get(`/api/student/notes/${id}`),
  },

  /* ---- Assignments + own single submission ---- */
  assignments: {
    list: (params) => api.get(`/api/student/assignments${qs(params)}`), // items include mySubmission
    get: (id) => api.get(`/api/student/assignments/${id}`),
    submission: (assignmentId) => api.get(`/api/student/assignments/${assignmentId}/submission`),
    submit: (assignmentId, body) => api.post(`/api/student/assignments/${assignmentId}/submission`, body), // { textAnswer }
  },

  /* ---- Timetable (monday–saturday, PKT wall-clock) ---- */
  timetable: {
    list: (params) => api.get(`/api/student/timetable${qs(params)}`), // day | status | page | limit
  },

  /* ---- Attendance: active own-section sessions + code entry + own history ---- */
  attendance: {
    activeSessions: () => api.get('/api/student/attendance/sessions'),
    attendWithCode: (sessionId, code) => api.post(`/api/student/attendance/sessions/${sessionId}/attend`, { code }),
    scanQr: (qr) => api.post('/api/student/attendance/scan', { qr }),
    history: (params) => api.get(`/api/student/attendance${qs(params)}`), // page | limit | subjectId | from | to
  },

  /* ---- Assessments & marks (read-only; drafts never visible) ---- */
  marks: {
    assessments: (params) => api.get(`/api/student/assessments${qs(params)}`), // items include myMark
    myMarks: (params) => api.get(`/api/student/marks${qs(params)}`),
  },

  /* ---- Secure Cloudinary direct upload (sign → browser upload → confirm) ---- */
  files: {
    sign: (body) => api.post('/api/student/files/sign', body), // { parentType: 'submission', parentId, file: { originalName, mimeType } }
    confirm: (body) => api.post('/api/student/files/confirm', body), // { parentType, parentId, result }
    remove: (body) => api.post('/api/student/files/remove', body), // { parentType, parentId, publicId }
  },

  /* ---- Notifications (own mailbox only) ---- */
  notifications: {
    list: (params) => api.get(`/api/student/notifications${qs(params)}`),
    unreadCount: () => api.get('/api/student/notifications/unread-count'),
    read: (id) => api.post(`/api/student/notifications/${id}/read`),
    readAll: () => api.post('/api/student/notifications/read-all'),
  },
};
