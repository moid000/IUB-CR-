import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Per-user, per-item NEW state backed by the existing Notification mailbox.
 * Opening a page never clears anything. A content notification becomes read
 * only when its actual card is opened (or a ?focus deep-link lands on it).
 */
export default function useUnreadContent(notificationsApi, type, items = []) {
  const [entries, setEntries] = useState([]);
  const [ready, setReady] = useState(false);
  const focusedOnce = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    notificationsApi.unreadContentRefs(type)
      .then((res) => {
        if (!cancelled) setEntries(Array.isArray(res?.data) ? res.data : []);
      })
      .catch(() => { if (!cancelled) setEntries([]); })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [notificationsApi, type]);

  const byRef = useMemo(() => {
    const map = new Map();
    for (const n of entries) if (n?.refId) map.set(String(n.refId), n);
    return map;
  }, [entries]);

  const isNew = useCallback((id) => byRef.has(String(id)), [byRef]);

  const markSeen = useCallback(async (refId) => {
    const key = String(refId);
    const notification = byRef.get(key);
    if (!notification?._id) return false;

    // Optimistic so the card settles immediately; restore on a real failure.
    setEntries((prev) => prev.filter((n) => String(n.refId) !== key));
    try {
      await notificationsApi.read(notification._id);
      window.dispatchEvent(new CustomEvent('tri3m:notifications-changed'));
      return true;
    } catch {
      setEntries((prev) => prev.some((n) => String(n.refId) === key) ? prev : [notification, ...prev]);
      return false;
    }
  }, [byRef, notificationsApi]);

  // Device-push / notification / dashboard deep-link: landing on a specific
  // card counts as viewing it, even if the page only highlights (not modal-opens).
  useEffect(() => {
    if (!ready || !items.length) return;
    const focus = new URLSearchParams(window.location.search).get('focus');
    if (!focus || focusedOnce.current === focus || !items.some((x) => String(x._id) === focus)) return;
    focusedOnce.current = focus;
    markSeen(focus);
  }, [ready, items, markSeen]);

  const ordered = useCallback((list) => [...list].sort((a, b) => {
    const unreadOrder = Number(isNew(b._id)) - Number(isNew(a._id));
    return unreadOrder || 0; // stable sort preserves the page's existing order
  }), [isNew]);

  return { isNew, markSeen, ordered, newCount: byRef.size, ready };
}
