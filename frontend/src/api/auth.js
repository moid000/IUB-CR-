/** Auth endpoints — the only API surface this phase consumes. */
import { api } from './client.js';

export const authApi = {
  me: () => api.get('/api/auth/me'),
  login: (email, password) => api.post('/api/auth/login', { email, password }),
  logout: () => api.post('/api/auth/logout'),

  lookupActivation: (role, email) =>
    api.post(`/api/auth/${role}/lookup`, { email }),
  requestActivationOtp: (role, email) =>
    api.post(`/api/auth/${role}/request-otp`, { email }),
  verifyActivationOtp: (role, email, otp) =>
    api.post(`/api/auth/${role}/verify-otp`, { email, otp }),
  setActivationPassword: (role, activationToken, password) =>
    api.post(`/api/auth/${role}/set-password`, { activationToken, password }),

  changePassword: (currentPassword, newPassword) =>
    api.post('/api/auth/change-password', { currentPassword, newPassword }),

  /* STEP 18 — self-service avatar (folder/publicId derived server-side) */
  avatar: {
    sign: (body) => api.post('/api/auth/avatar/sign', body), // { file: { originalName, mimeType } }
    confirm: (body) => api.post('/api/auth/avatar/confirm', body), // { result }
    remove: () => api.post('/api/auth/avatar/remove'),
  },

  requestResetOtp: (email) => api.post('/api/auth/forgot-password/request-otp', { email }),
  verifyResetOtp: (email, otp) => api.post('/api/auth/forgot-password/verify-otp', { email, otp }),
  setResetPassword: (resetToken, password) =>
    api.post('/api/auth/forgot-password/set-password', { resetToken, password }),
};
