import { useEffect, useRef, useState } from 'react';

/**
 * Count-up number — animates from 0 to `value` once it mounts/changes.
 * Used across admin metric cards so numbers feel alive, not static.
 * Non-numeric values (e.g. '—', '') render as-is, unanimated.
 */
export function CountUp({ value, duration = 900 }) {
  const numeric = typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
  const [display, setDisplay] = useState(numeric ? 0 : value);
  const prevValue = useRef(numeric ? 0 : value);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!numeric) { setDisplay(value); prevValue.current = value; return undefined; }
    const from = typeof prevValue.current === 'number' ? prevValue.current : 0;
    const to = value;
    if (from === to) { setDisplay(to); return undefined; }
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min((t - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else prevValue.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, numeric, duration]);

  return <>{display}</>;
}
