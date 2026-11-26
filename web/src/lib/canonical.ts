import { useEffect } from 'react';
import { SITE_URL } from './links';

/** A page's canonical address: always on cubr.dev, whichever host (or local stack) served it. */
export function canonicalUrl(path: string): string {
  return `${SITE_URL}${path}`;
}

/**
 * One address per page for search engines: a `<link rel="canonical">` with the page's own address while
 * it shows, removed again on leaving. nginx already sends capitals and trailing slashes there (301,
 * map $cubr_canonical); this covers what nginx can't know: a board's query, a query added to the home
 * page. (Profiles have none: they stay out of search results.) `null`: no link (still loading, or a page search engines
 * shouldn't list). Only pages call this, so there's never more than one.
 */
export function useCanonical(path: string | null): void {
  useEffect(() => {
    if (path === null) return;
    const link = document.createElement('link');
    link.rel = 'canonical';
    link.href = canonicalUrl(path);
    document.head.append(link);
    return () => link.remove();
  }, [path]);
}

/**
 * A leaderboard's canonical address: its event, kind and period, never the page or the day (one board,
 * however far down you are); the default board (3x3 single, all-time) is plain /leaderboards, as in
 * the sitemap.
 */
export function leaderboardCanonical(s: { event: string; kind: string; period: string }): string {
  if (s.event === '333' && s.kind === 'single' && s.period === 'all') return '/leaderboards';
  return `/leaderboards?${new URLSearchParams({ event: s.event, kind: s.kind, period: s.period }).toString()}`;
}
