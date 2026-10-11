import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

vi.mock('../api/admin.js', () => ({
  adminApi: {
    administration: { getProfile: vi.fn(async () => ({ data: { configured: false, profile: null } })),
      updateProfile: vi.fn(async () => ({})) },
    chatbot: { get: vi.fn(async () => ({ enabled: false, apiKeyConfigured: false })),
      update: vi.fn(async () => ({})) },
    experience: { get: vi.fn(async () => ({ data: {} })), refresh: vi.fn(async () => ({ data: {} })) },
  },
}));
vi.mock('../api/client.js', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));

const { default: AdministrationPage } = await import('../pages/admin/AdministrationPage.jsx');
describe('AdministrationPage render smoke', () => {
  it('renders without crashing (owner 2026-10-11 live crash report)', () => {
    const html = renderToString(<AdministrationPage />);
    expect(html).toContain('Administration');
  });
});
