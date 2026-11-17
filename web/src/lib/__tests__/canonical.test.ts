import { describe, expect, it } from 'vitest';
import sitemapXml from '../../../public/sitemap.xml?raw';
import { canonicalUrl, leaderboardCanonical } from '../canonical';

describe('canonical addresses', () => {
  it('always point at cubr.dev, whichever host served the page', () => {
    expect(canonicalUrl('/about')).toBe('https://cubr.dev/about');
    expect(canonicalUrl('/')).toBe('https://cubr.dev/');
  });

  it("give a board its event, kind and period, never the page or the day; the default board is plain /leaderboards", () => {
    expect(leaderboardCanonical({ event: '333', kind: 'single', period: 'all' })).toBe('/leaderboards');
    expect(leaderboardCanonical({ event: '444', kind: 'ao5', period: 'weekly' })).toBe('/leaderboards?event=444&kind=ao5&period=weekly');
    expect(leaderboardCanonical({ event: '333', kind: 'ao5', period: 'challenge', page: 3, date: '2026-11-15' } as never)).toBe('/leaderboards?event=333&kind=ao5&period=challenge');
  });

  it("match the sitemap's addresses", () => {
    const listed = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const path of ['/', '/daily', '/leaderboards', '/race', '/wca', '/about', '/terms', '/privacy']) expect(listed).toContain(canonicalUrl(path));
  });
});
