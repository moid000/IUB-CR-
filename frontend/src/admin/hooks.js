import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.js';

/**
 * Shared list-page state: fetch + loading + error + reload.
 * `fetcher` must return the parsed JSON body ({ success, data, pagination? }).
 */
export function useAdminQuery(fetcher, deps = []) {
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcherRef.current()
      .then((res) => {
        if (cancelled) return;
        setItems(res?.data ?? []);
        setPagination(res?.pagination ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setItems([]);
        setPagination(null);
        setError(err instanceof ApiError ? err : new ApiError(500, 'Something went wrong. Please try again.'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { items, pagination, loading, error, reload };
}

/** Debounced value — keeps search from firing a request per keystroke. */
export function useDebounced(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Gentle success toast state — auto-clears so nothing lingers forever. */
export function useFlash(timeout = 3500) {
  const [flash, setFlash] = useState(null);
  const tRef = useRef(null);
  const show = useCallback((message) => {
    setFlash(message);
    clearTimeout(tRef.current);
    tRef.current = setTimeout(() => setFlash(null), timeout);
  }, [timeout]);
  useEffect(() => () => clearTimeout(tRef.current), []);
  return [flash, show];
}
