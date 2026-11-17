import { useEffect } from 'react';

/**
 * Asks search engines not to list the page while it shows: a `<meta name="robots" content="noindex">`
 * in the head, removed again on leaving. For not-found views the server can't recognise, which answer
 * 200 (a well-formed username nobody has, say); Google reads the tag after it renders the page.
 */
export function useNoIndex(active = true): void {
  useEffect(() => {
    if (!active) return;
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.append(meta);
    return () => meta.remove();
  }, [active]);
}
