import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isChunkLoadError, PageErrorBoundary, ErrorBoundary } from '../pages/ErrorBoundary.jsx';

/**
 * 2026-09-22 (owner screenshot): "This page couldn't load" appeared
 * randomly and "Try again" did nothing — only a full app restart/hard
 * refresh fixed it. Root cause: every page is lazy()-loaded; after a new
 * deploy, a tab open since before it still points at OLD chunk filenames
 * that no longer exist on the CDN, so the dynamic import() 404s and
 * throws — React.lazy() then caches that rejection FOREVER, so "Try
 * again" (which just remounts) re-throws the identical cached failure.
 * Fix: detect this specific error class and auto window.location.reload()
 * instead of showing the generic dead-end card.
 */
describe('isChunkLoadError — recognises stale-deploy module failures', () => {
  it('matches Vite dynamic-import-failed message (the exact class of bug reported)', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://iubcr.vercel.app/frontend/assets/AssignmentsPage-old123.js'))).toBe(true);
  });

  it('matches "error loading dynamically imported module"', () => {
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
  });

  it('matches webpack-style ChunkLoadError by name', () => {
    const err = new Error('Loading chunk 42 failed');
    err.name = 'ChunkLoadError';
    expect(isChunkLoadError(err)).toBe(true);
  });

  it('does NOT flag an ordinary render bug as a chunk error', () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });

  it('handles null/undefined safely', () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('PageErrorBoundary / ErrorBoundary — auto-heal on chunk error', () => {
  let store;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('sessionStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('PageErrorBoundary marks chunk+autoReloading true for a stale-chunk error (fresh session)', () => {
    const state = PageErrorBoundary.getDerivedStateFromError(
      new Error('Failed to fetch dynamically imported module')
    );
    expect(state.hasError).toBe(true);
    expect(state.chunk).toBe(true);
    expect(state.autoReloading).toBe(true);
  });

  it('PageErrorBoundary does NOT auto-reload for an ordinary render crash', () => {
    const state = PageErrorBoundary.getDerivedStateFromError(new Error('boom, undefined is not a function'));
    expect(state.chunk).toBe(false);
    expect(state.autoReloading).toBe(false);
  });

  it('guards against a reload loop — a second chunk error within 10s does not re-claim', () => {
    const first = PageErrorBoundary.getDerivedStateFromError(new Error('Failed to fetch dynamically imported module'));
    expect(first.autoReloading).toBe(true);
    const second = PageErrorBoundary.getDerivedStateFromError(new Error('Failed to fetch dynamically imported module'));
    expect(second.chunk).toBe(true);
    expect(second.autoReloading).toBe(false); // cooldown — falls back to a manual "Reload now" button
  });

  it('top-level ErrorBoundary has the same chunk-aware auto-heal behaviour', () => {
    const state = ErrorBoundary.getDerivedStateFromError(new Error('error loading dynamically imported module'));
    expect(state.chunk).toBe(true);
    expect(state.autoReloading).toBe(true);
  });
});
