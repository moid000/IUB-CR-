import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Notification deep-link landing: the URL carries ?focus=<itemId>; once the
 * matching [data-item-id] element renders, scroll to it and pulse a soft blue
 * ring on it, then clear the param. Retries while lists load; gives up
 * silently after ~12s (item filtered out, archived, collapsed, etc.).
 *
 * @param {*} dep list data this page renders — effect re-arms when it changes.
 */
export default function useFocusHighlight(dep) {
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get('focus');

  useEffect(() => {
    if (!focusId) return undefined;
    let tries = 0;
    let pollTimer;
    let ringTimer;

    const clear = () => {
      searchParams.delete('focus');
      setSearchParams(searchParams, { replace: true });
    };

    const attempt = () => {
      const el = document.querySelector(`[data-item-id="${focusId}"]`);
      if (!el) {
        if (++tries > 40) clear();
        else pollTimer = setTimeout(attempt, 300);
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('focus-highlight');
      ringTimer = setTimeout(() => {
        el.classList.remove('focus-highlight');
        clear();
      }, 4500);
    };

    attempt();
    return () => {
      clearTimeout(pollTimer);
      clearTimeout(ringTimer);
      document.querySelectorAll('.focus-highlight').forEach((e) => e.classList.remove('focus-highlight'));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, dep]);

  return focusId;
}
