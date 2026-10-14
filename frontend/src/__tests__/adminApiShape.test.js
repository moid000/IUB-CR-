/**
 * ADMIN API SHAPE (owner incident 2026-10-14): the Administration page
 * crashed on EVERY device with
 *   TypeError: Cannot read properties of undefined (reading 'get')
 * because the 'experience' block was accidentally NESTED inside 'chatbot'
 * in api/admin.js — adminApi.experience.get() did not exist. The live-mount
 * test never caught it because it MOCKED admin.js with the correct shape.
 *
 * This test imports the REAL module (no mocks) and asserts every property
 * the pages actually call, so a nesting slip fails CI instead of production.
 */
import { describe, it, expect } from 'vitest';
import { adminApi } from '../api/admin.js';

describe('AAS: real adminApi shape (no mocks)', () => {
  it('Administration page deps exist at top level', () => {
    expect(typeof adminApi.administration?.getProfile).toBe('function');
    expect(typeof adminApi.chatbot?.get).toBe('function');
    expect(typeof adminApi.chatbot?.update).toBe('function');
    // The 2026-10-14 crash: experience must be TOP-LEVEL, not nested in chatbot.
    expect(typeof adminApi.experience?.get).toBe('function');
    expect(typeof adminApi.experience?.refresh).toBe('function');
  });

  it('chatbot has no stray nested service groups', () => {
    // If someone nests a sibling service inside chatbot again, catch it here.
    const stray = Object.keys(adminApi.chatbot || {}).filter(
      (k) => !['get', 'update'].includes(k),
    );
    expect(stray).toEqual([]);
  });
});
