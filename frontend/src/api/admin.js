/**
 * Admin API layer — thin wrappers over the EXACT backend contracts.
 * No endpoint names are invented; payloads contain only fields the
 * backend explicitly accepts (server-controlled fields never sent).
 */
import { api } from './client.js';

const qs = (params = {}) => {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 'all')
  );
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
};

export const adminApi = {
  departments: {
    list: (params) => api.get(`/api/admin/departments${qs(params)}`), // → { data: [...] }
    create: (body) => api.post('/api/admin/departments', body), // { name, code }
    update: (id, body) => api.patch(`/api/admin/departments/${id}`, body), // { name?, code? }
    archive: (id) => api.post(`/api/admin/departments/${id}/archive`),
    delete: (id) => api.del(`/api/admin/departments/${id}`), // hard delete; blocked while sections exist
  },
  sessions: {
    list: (params) => api.get(`/api/admin/sessions${qs(params)}`),
    create: (body) => api.post('/api/admin/sessions', body), // { name, startedAt?, endedAt?, status? }
    update: (id, body) => api.patch(`/api/admin/sessions/${id}`, body),
    archive: (id) => api.post(`/api/admin/sessions/${id}/archive`),
    delete: (id) => api.del(`/api/admin/sessions/${id}`), // hard delete; blocked while sections exist
  },
  sections: {
    list: (params) => api.get(`/api/admin/sections${qs(params)}`), // department | session | status
    create: (body) => api.post('/api/admin/sections', body), // { department, session, semester, name, cr? }
    update: (id, body) => api.patch(`/api/admin/sections/${id}`, body), // { name?, semester? }
    archive: (id) => api.post(`/api/admin/sections/${id}/archive`),
    // Dedicated CR flows — ownership is NEVER injected into section payloads
    assignCr: (sectionId, userId, role = 'cr') => api.post(`/api/admin/sections/${sectionId}/cr`, { userId, role }),
    reassignCr: (sectionId, userId, role = 'cr') => api.post(`/api/admin/sections/${sectionId}/cr/reassign`, { userId, role }),
    removeCr: (sectionId, role = 'cr') => api.post(`/api/admin/sections/${sectionId}/cr/remove`, { role }),
    delete: (id) => api.del(`/api/admin/sections/${id}`), // hard delete; blocked while CR/students/subjects exist
  },
  crs: {
    list: (params) => api.get(`/api/admin/crs${qs(params)}`), // search | section | page | limit
    precreate: (body) => api.post('/api/admin/crs', body), // { name, email, phone?, role?: 'cr'|'gr', sectionId } OR { ...sectionName }
    delete: (id) => api.del(`/api/admin/crs/${id}`), // unlinks the CR from their section, removes the account
  },
  students: {
    list: (params) => api.get(`/api/admin/students${qs(params)}`), // search | section | department | session | page | limit
    delete: (id) => api.del(`/api/admin/students/${id}`), // cascades submissions/marks/notifications
  },
  subjects: {
    list: (params) => api.get(`/api/admin/subjects${qs(params)}`), // search | sectionId | status | page | limit
    create: (body) => api.post('/api/admin/subjects', body), // { section, name, code, teacherName?, creditHours?, description? }
    update: (id, body) => api.patch(`/api/admin/subjects/${id}`, body),
    archive: (id) => api.post(`/api/admin/subjects/${id}/archive`),
    delete: (id) => api.del(`/api/admin/subjects/${id}`), // hard delete; blocked while notes/assignments/timetable/assessments exist
  },
  administration: {
    // Owner/administration profile — the contact pair every data deletion is
    // gated behind (a wipe now requires codes emailed AND WhatsApped here).
    getProfile: () => api.get('/api/admin/administration/profile'),
    updateProfile: (body) => api.put('/api/admin/administration/profile', body), // { name?, email, whatsapp }
  },
};