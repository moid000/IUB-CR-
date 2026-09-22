/**
 * CR API layer — thin wrappers over the EXACT backend contracts.
 * Every route is section-scoped SERVER-SIDE (derived from the authenticated
 * CR); the frontend NEVER sends section/role/ownership fields.
 */
import { api } from './client.js';

const qs = (params = {}) => {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 'all')
  );
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
};

export const crApi = {
  /* ---- ONE-request dashboard aggregate ---- */
  overview: () => api.get('/api/cr/overview'), // { counts, announcements, assignments, todayClasses }
  overviewCached: () => api.peek('/api/cr/overview'), // last known snapshot (SWR instant paint)

  /* ---- Students (list + precreate — section ALWAYS server-derived) ---- */
  students: {
    list: (params) => api.get(`/api/cr/students${qs(params)}`), // page | limit → { data, pagination }
    precreate: (body) => api.post('/api/cr/students', body), // { name, rollNo, email, phone? }
  },

  /* ---- Subjects ---- */
  subjects: {
    list: (params) => api.get(`/api/cr/subjects${qs(params)}`),
    cachedList: (params) => api.peek(`/api/cr/subjects${qs(params)}`), // SWR snapshot // search | status | page | limit
    create: (body) => api.post('/api/cr/subjects', body), // { name, code, teacherName?, creditHours?, description? }
    update: (id, body) => api.patch(`/api/cr/subjects/${id}`, body),
    archive: (id) => api.post(`/api/cr/subjects/${id}/archive`),
    delete: (id) => api.del(`/api/cr/subjects/${id}`), // hard delete; blocked while notes/assignments/etc. exist
  },

  /* ---- WhatsApp class group (section broadcasts; marks never broadcast) ---- */
  whatsappGroup: {
    config: () => api.get('/api/cr/whatsapp-group'), // { group, gatewayPhone, appUrl }
    refreshGroups: () => api.get('/api/cr/whatsapp-group/groups'), // { groups: [{id,name}] }
    link: (body) => api.put('/api/cr/whatsapp-group', body), // { groupId, groupName }
    unlink: () => api.del('/api/cr/whatsapp-group'),
  },

  /* ---- Teachers (one teacher per subject — WhatsApp deadline alerts) ---- */
  teachers: {
    list: (params) => api.get(`/api/cr/teachers${qs(params)}`), // search | page | limit
    create: (body) => api.post('/api/cr/teachers', body), // { name, subject, whatsapp, email?, designation? }
    update: (id, body) => api.patch(`/api/cr/teachers/${id}`, body),
    delete: (id) => api.del(`/api/cr/teachers/${id}`),
  },

  /* ---- Announcements ---- */
  announcements: {
    list: (params) => api.get(`/api/cr/announcements${qs(params)}`),
    cachedList: (params) => api.peek(`/api/cr/announcements${qs(params)}`), // SWR snapshot // search | status | page | limit
    get: (id) => api.get(`/api/cr/announcements/${id}`),
    create: (body) => api.post('/api/cr/announcements', body), // { title, content, pinned? }
    update: (id, body) => api.patch(`/api/cr/announcements/${id}`, body), // { title?, content?, pinned? }
    archive: (id) => api.post(`/api/cr/announcements/${id}/archive`),
    broadcast: (id) => api.post(`/api/cr/announcements/${id}/broadcast`), // combined text+media group send
    delete: (id) => api.del(`/api/cr/announcements/${id}`), // permanently removes the announcement
  },

  /* ---- Notes (optional subject must belong to own section) ---- */
  notes: {
    list: (params) => api.get(`/api/cr/notes${qs(params)}`), // search | status | subjectId | page | limit
    get: (id) => api.get(`/api/cr/notes/${id}`),
    create: (body) => api.post('/api/cr/notes', body), // { title, content?, subject? }
    update: (id, body) => api.patch(`/api/cr/notes/${id}`, body),
    archive: (id) => api.post(`/api/cr/notes/${id}/archive`),
    broadcast: (id) => api.post(`/api/cr/notes/${id}/broadcast`), // combined text+media group send
    delete: (id) => api.del(`/api/cr/notes/${id}`), // permanently removes the note + its files
  },

  /* ---- Assignments ---- */
  assignments: {
    list: (params) => api.get(`/api/cr/assignments${qs(params)}`),
    cachedList: (params) => api.peek(`/api/cr/assignments${qs(params)}`), // SWR snapshot // search | status | subjectId | page | limit
    get: (id) => api.get(`/api/cr/assignments/${id}`),
    create: (body) => api.post('/api/cr/assignments', body), // { subject, title, instructions?, deadline }
    update: (id, body) => api.patch(`/api/cr/assignments/${id}`, body), // { subject?, title?, instructions?, deadline? }
    archive: (id) => api.post(`/api/cr/assignments/${id}/archive`),
    broadcast: (id) => api.post(`/api/cr/assignments/${id}/broadcast`), // combined text+media group send
    delete: (id) => api.del(`/api/cr/assignments/${id}`), // permanently removes the assignment + all submissions
    submissions: (id, params) => api.get(`/api/cr/assignments/${id}/submissions${qs(params)}`),
  },

  /* ---- Timetable (monday–saturday, HH:MM wall-clock, overlap → 409) ---- */
  timetable: {
    list: (params) => api.get(`/api/cr/timetable${qs(params)}`), // date | subjectId | status | page | limit
    cachedList: (params) => api.peek(`/api/cr/timetable${qs(params)}`), // SWR snapshot
    create: (body) => api.post('/api/cr/timetable', body), // { subject, date, startTime, endTime, room? }
    copy: (body) => api.post('/api/cr/timetable/copy', body), // { fromDate, toDate } → { copied, skipped }
    update: (id, body) => api.patch(`/api/cr/timetable/${id}`, body),
    archive: (id) => api.post(`/api/cr/timetable/${id}/archive`),
    delete: (id) => api.del(`/api/cr/timetable/${id}`), // permanently removes the slot
  },

  /* ---- Attendance (code + QR returned EXACTLY ONCE at creation) ---- */
  attendance: {
    createSession: (body) => api.post('/api/cr/attendance/sessions', body), // { subject }
    listSessions: (params) => api.get(`/api/cr/attendance/sessions${qs(params)}`), // status | subjectId | page | limit
    getSession: (id) => api.get(`/api/cr/attendance/sessions/${id}`),
    cancelSession: (id) => api.post(`/api/cr/attendance/sessions/${id}/cancel`),
    records: (id, params) => api.get(`/api/cr/attendance/sessions/${id}/records${qs(params)}`),
  },

  /* ---- Assessments & marks (draft → open → finalized → archived) ---- */
  assessments: {
    list: (params) => api.get(`/api/cr/assessments${qs(params)}`), // status | subjectId | type | page | limit
    get: (id) => api.get(`/api/cr/assessments/${id}`),
    create: (body) => api.post('/api/cr/assessments', body), // { subject, title, type, totalMarks, assessmentDate, weightage? }
    update: (id, body) => api.patch(`/api/cr/assessments/${id}`, body),
    open: (id) => api.post(`/api/cr/assessments/${id}/open`),
    finalize: (id) => api.post(`/api/cr/assessments/${id}/finalize`),
    archive: (id) => api.post(`/api/cr/assessments/${id}/archive`),
    delete: (id) => api.del(`/api/cr/assessments/${id}`), // permanently removes the assessment (marks cascade)
    marks: {
      list: (id) => api.get(`/api/cr/assessments/${id}/marks`), // → { assessment, items, missing, counts }
      bulk: (id, rows) => api.post(`/api/cr/assessments/${id}/marks/bulk`, { rows }), // [{ student, marksObtained }]
    },
  },

  /* ---- Notifications (own mailbox; reminders lazily generated server-side) ---- */
  notifications: {
    list: (params) => api.get(`/api/cr/notifications${qs(params)}`), // unread | page | limit
    unreadCount: () => api.get('/api/cr/notifications/unread-count'),
    unreadByType: () => api.get('/api/cr/notifications/unread-count-by-type'), // -> { byType, total }
    unreadContentRefs: (type) => api.get(`/api/cr/notifications/unread-content-refs?type=${encodeURIComponent(type)}`),
    readByType: (types) => api.post('/api/cr/notifications/read-by-type', { types }), // → { count }
    read: (id) => api.post(`/api/cr/notifications/${id}/read`),
    readAll: () => api.post('/api/cr/notifications/read-all'),
  },

  /* ---- Signed Cloudinary uploads (sign → browser upload → confirm) ---- */
  files: {
    sign: (body) => api.post('/api/cr/files/sign', body), // { parentType, parentId, file: { originalName, mimeType } }
    confirm: (body) => api.post('/api/cr/files/confirm', body), // { parentType, parentId, result }
    remove: (body) => api.post('/api/cr/files/remove', body), // { parentType, parentId, publicId }
  },
};
