import { useEffect, useRef, useState, useCallback } from 'react';
import { IconDownload, IconX } from '../icons.jsx';
import { downloadFile, downloadName, previewUrl } from '../../api/upload.js';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;

/**
 * Fullscreen zoomable image viewer for attachment previews.
 *
 * Built 2026-09-22: the old lightbox had NO zoom of its own, so users
 * pinch-zoomed with the browser's NATIVE page zoom — that re-rasterizes the
 * entire page (modal, backdrop, every card) on every frame, which is what
 * felt "bohot slow / lag karti" while zooming and panning on phones.
 * This viewer zooms/pans ONLY the image with a CSS `transform`
 * (GPU-accelerated, no layout work): one-finger pan, two-finger pinch,
 * double-tap toggle, wheel zoom + buttons on desktop. The transform is
 * written straight to the element style during gestures (no React
 * re-render per frame) so it stays smooth even on low-end phones.
 * Backdrop is a SOLID dark color — no backdrop-blur filter (mobile perf).
 */
export function ImageLightbox({ file, onClose }) {
  const stageRef = useRef(null);
  const imgRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  // 'idle' | 'saving' | 'saved' — 'saving' shows the instant the button is
  // pressed so it never feels like the tap did nothing.
  const [saveState, setSaveState] = useState('idle');
  // Transform lives in a ref — mutated during gestures without re-rendering.
  const t = useRef({ x: 0, y: 0, scale: 1 });
  // Gesture bookkeeping: active pointers + baselines captured at gesture start.
  const g = useRef({
    pointers: new Map(), // pointerId -> {x, y}
    start: null, // {dist, cx, cy, tx, ty, scale} at two-pointer gesture start
    last: null, // last single-pointer position
    dragging: false,
  });
  const lastTap = useRef({ time: 0, x: 0, y: 0 });
  const [scaleDisplay, setScaleDisplay] = useState(1);

  const apply = useCallback((withTransition = false) => {
    const el = imgRef.current;
    if (!el) return;
    el.style.transition = withTransition ? 'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
    el.style.transform = `translate(${t.current.x}px, ${t.current.y}px) scale(${t.current.scale})`;
    setScaleDisplay(Math.round(t.current.scale * 100));
  }, []);

  /** Keep the image within sane bounds after a gesture. */
  const clamp = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    const { scale } = t.current;
    if (scale <= MIN_SCALE) {
      t.current = { x: 0, y: 0, scale: MIN_SCALE };
      return;
    }
    const maxX = Math.max(0, ((el.clientWidth * scale) - el.clientWidth) / 2);
    const maxY = Math.max(0, ((el.clientHeight * scale) - el.clientHeight) / 2);
    t.current.x = Math.min(maxX, Math.max(-maxX, t.current.x));
    t.current.y = Math.min(maxY, Math.max(-maxY, t.current.y));
  }, []);

  /** Zoom by `factor` keeping the point (px,py) inside the stage fixed. */
  const zoomAt = useCallback((px, py, factor, animate = false) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const cx = px - rect.left - rect.width / 2;
    const cy = py - rect.top - rect.height / 2;
    const s0 = t.current.scale;
    const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s0 * factor));
    if (s1 === s0) return;
    // Keep the content under (px,py) stationary: (t + c) * s must be constant.
    t.current.x = (cx + t.current.x) * (s0 / s1) - cx;
    t.current.y = (cy + t.current.y) * (s0 / s1) - cy;
    t.current.scale = s1;
    clamp();
    apply(animate);
  }, [apply, clamp]);

  /** Save the ORIGINAL full-quality picture to the device. Uses a real
   *  forced-download (Cloudinary fl_attachment, see api/upload.js) — no
   *  popup photo-viewer, no blob/CORS wait. Feedback: busy immediately on
   *  press, confirmed tick shortly after. */
  const saveToGallery = useCallback(() => {
    if (!file) return;
    setSaveState('saving');
    downloadFile(file.url, downloadName(file));
    setTimeout(() => {
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2200);
    }, 550);
  }, [file]);

  const reset = useCallback(() => {
    t.current = { x: 0, y: 0, scale: 1 };
    apply(true);
  }, [apply]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (t.current.scale > MIN_SCALE) { reset(); } else { onClose?.(); }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose, reset]);

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    g.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Double-tap: toggle zoom at the tap point.
    const now = Date.now();
    const isTap = now - lastTap.current.time < DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 40;
    lastTap.current = { time: now, x: e.clientX, y: e.clientY };
    if (isTap && g.current.pointers.size === 1) {
      lastTap.current.time = 0;
      if (t.current.scale > MIN_SCALE + 0.01) reset();
      else zoomAt(e.clientX, e.clientY, DOUBLE_TAP_SCALE, true);
      return;
    }

    if (g.current.pointers.size === 1) {
      g.current.last = { x: e.clientX, y: e.clientY };
      g.current.dragging = t.current.scale > MIN_SCALE + 0.01;
    } else if (g.current.pointers.size === 2) {
      const [p1, p2] = [...g.current.pointers.values()];
      g.current.start = {
        dist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
        cx: (p1.x + p2.x) / 2,
        cy: (p1.y + p2.y) / 2,
        tx: t.current.x, ty: t.current.y, scale: t.current.scale,
      };
      g.current.dragging = false;
    }
  };

  const onPointerMove = (e) => {
    if (!g.current.pointers.has(e.pointerId)) return;
    g.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (g.current.pointers.size === 2 && g.current.start) {
      const [p1, p2] = [...g.current.pointers.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const s0 = g.current.start.scale;
      const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s0 * (dist / g.current.start.dist)));
      // Follow the midpoint delta so the image tracks the fingers.
      const cx = (p1.x + p2.x) / 2;
      const cy = (p1.y + p2.y) / 2;
      t.current.scale = s1;
      t.current.x = g.current.start.tx + (cx - g.current.start.cx);
      t.current.y = g.current.start.ty + (cy - g.current.start.cy);
      clamp();
      apply();
    } else if (g.current.pointers.size === 1 && g.current.dragging && g.current.last) {
      t.current.x += e.clientX - g.current.last.x;
      t.current.y += e.clientY - g.current.last.y;
      g.current.last = { x: e.clientX, y: e.clientY };
      clamp();
      apply();
    }
  };

  const onPointerUp = (e) => {
    g.current.pointers.delete(e.pointerId);
    if (g.current.pointers.size < 2) g.current.start = null;
    if (g.current.pointers.size === 1) {
      const [p] = [...g.current.pointers.values()];
      g.current.last = p;
      g.current.dragging = t.current.scale > MIN_SCALE + 0.01;
    } else if (g.current.pointers.size === 0) {
      g.current.dragging = false;
      // Snap back if under-zoomed or out of bounds.
      if (t.current.scale < MIN_SCALE + 0.01 || t.current.scale === MIN_SCALE) {
        t.current = { x: 0, y: 0, scale: MIN_SCALE };
      } else {
        clamp();
      }
      apply(true);
    }
  };

  const onWheel = (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  };

  const btn = 'grid size-9 place-items-center rounded-lg bg-white/10 text-white transition-colors hover:bg-white/20';

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/95"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${file?.originalName ?? 'image'}`}
    >
      {/* header */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-white/90">
          {file?.originalName ?? 'Preview'}
        </p>
        <div className="flex items-center gap-1.5">
          <button type="button" className={btn} aria-label="Zoom out" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.4, true)}>
            <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" d="M5 12h14" /></svg>
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-white/60" aria-live="polite">{scaleDisplay}%</span>
          <button type="button" className={btn} aria-label="Zoom in" onClick={() => zoomAt(innerWidth / 2, innerHeight / 2, 1.4, true)}>
            <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" d="M12 5v14M5 12h14" /></svg>
          </button>
          <button type="button" className={btn} aria-label="Reset zoom" onClick={reset}>
            <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          </button>
          <button type="button" className={btn} aria-label="Close preview" onClick={onClose}>
            <IconX className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* zoomable stage */}
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      >
        {!loaded && <div className="absolute inset-0 grid place-items-center text-xs text-white/50">Loading image…</div>}
        <img
          ref={imgRef}
          src={previewUrl(file?.url, 1600)}
          alt={file?.originalName ?? 'attachment'}
          className="max-h-full max-w-full object-contain will-change-transform"
          draggable={false}
          onLoad={() => setLoaded(true)}
        />
      </div>

      {/* footer — Save to gallery is the primary action (owner request
          2026-09-22); Open full size stays for browser/other-app viewing */}
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={saveToGallery}
          disabled={saveState === 'saving'}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium leading-none text-white transition-colors hover:bg-primary-700 disabled:opacity-80"
        >
          {saveState === 'saving' ? (
            <>
              <svg className="size-4 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.3" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
              Saving…
            </>
          ) : saveState === 'saved' ? (
            <>
              <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
              Saved
            </>
          ) : (
            <>
              <IconDownload className="size-4 shrink-0" aria-hidden="true" />
              Save to gallery
            </>
          )}
        </button>
        <a
          href={file?.url} target="_blank" rel="noopener noreferrer"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-white/10 px-4 text-sm font-medium leading-none text-white transition-colors hover:bg-white/20"
        >
          Open full size
        </a>
      </div>
    </div>
  );
}
