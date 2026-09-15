import { useEffect } from 'react';

/**
 * Lock body scroll while `active` is true (mobile drawers, sheets).
 * Ref-count safe: restores the previous value exactly on cleanup.
 */
export function useBodyScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [active]);
}
