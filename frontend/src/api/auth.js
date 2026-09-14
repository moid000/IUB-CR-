/** Auth endpoints — the only API surface this phase consumes. */
import { api } from './client.js';

export const authApi = {
  me: () => api.get('/api/auth/me'),
  login: (email, password) => api.post('/api/auth/login', { email, password }),
  logout: () => api.post('/api/auth/logout'),

  requestActivationOtp: (role, email) =>
    api.post(`/api/auth/${role}/request-otp`, { email }),
  verifyActivationOtp: (role, email, otp) =>
    api.post(`/api/auth/${role}/verify-otp`, { email, otp }),
  setActivationPassword: (role, activationToken, password) =>
    api.post(`/api/auth/${role}/set-password`, { activationToken, password }),

  requestResetOtp: (email) => api.post('/api/auth/forgot-password/request-otp', { email }),
  verifyResetOtp: (email, otp) => api.post('/api/auth/forgot-password/verify-otp', { email, otp }),
  setResetPassword: (resetToken, password) =>
    api.post('/api/auth/forgot-password/set-password', { resetToken, password }),
};
