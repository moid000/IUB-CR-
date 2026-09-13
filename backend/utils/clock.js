/**
 * Single source of truth for "now" in deadline enforcement.
 *
 * Production: real server UTC time. Tests: may pin `MOCK_NOW` (epoch ms) for
 * deterministic before/at/after-deadline checks — same process as the app in
 * the test suite. The deadline rule itself ALWAYS lives server-side:
 * eligible iff now() <= assignment.deadline (UTC comparison).
 */
export function now() {
  const mock = Number.parseInt(process.env.MOCK_NOW, 10);
  return Number.isFinite(mock) ? mock : Date.now();
}

export const nowDate = () => new Date(now());
