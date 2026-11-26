import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import appSource from '../App.tsx?raw';
import timerSource from '../pages/TimerPage.tsx?raw';
import dailySource from '../pages/DailyPage.tsx?raw';
import raceSource from '../pages/RaceLobbyPage.tsx?raw';
import layoutSource from '../components/Layout.tsx?raw';
import leaderboardsSource from '../pages/LeaderboardsPage.tsx?raw';
import wcaSource from '../pages/WcaPage.tsx?raw';
import aboutSource from '../pages/AboutPage.tsx?raw';
import sitemapXml from '../../public/sitemap.xml?raw';
import { pageFile, pageHtml } from '../../plugins/pageFiles';
import { HOME, PAGE_META, type PageMeta } from '../lib/pageMeta';

// What search engines show for each public page (lib/pageMeta.ts), the home page's copy of it in
// index.html, and the build step that writes every other public page's own HTML (plugins/pageFiles.ts).

const pages = Object.entries(PAGE_META) as [string, PageMeta][];

/** The words cubr wants to be found by: speedcube, cube and timer, and their family. */
const FOCUS = /\b(?:speedcub(?:e|es|ing|er|ers)|cub(?:e|es|ing|er|ers)|timers?|timing)\b/gi;
const focusWords = (s: string) => s.match(FOCUS) ?? [];

/** An attribute or element of index.html (or a page's copy), unescaped. */
const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
function head(html: string) {
  const attr = (re: RegExp) => unescape(re.exec(html)?.[1] ?? '');
  const summary = /<div id="page-summary"([^>]*)>\s*<h1>([^<]*)<\/h1>\s*<p>([^<]*)<\/p>([\s\S]*?)<\/div>/.exec(html);
  return {
    title: attr(/<title>([^<]*)<\/title>/),
    description: attr(/<meta name="description" content="([^"]*)"/),
    ogTitle: attr(/<meta property="og:title" content="([^"]*)"/),
    ogDescription: attr(/<meta property="og:description" content="([^"]*)"/),
    ogSiteName: attr(/<meta property="og:site_name" content="([^"]*)"/),
    summaryStyle: summary?.[1] ?? '',
    heading: unescape(summary?.[2] ?? ''),
    line: unescape(summary?.[3] ?? ''),
    links: [...(summary?.[4] ?? '').matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]),
  };
}

describe("the public pages' titles and descriptions", () => {
  it('cover exactly the pages in the sitemap, each a route of the app', () => {
    const routes = [...appSource.matchAll(/\{ path: '([^']+)'/g)].map((m) => m[1]);
    const listed = [...sitemapXml.matchAll(/<loc>https:\/\/cubr\.dev([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(Object.keys(PAGE_META).sort()).toEqual([...listed].sort());
    for (const path of Object.keys(PAGE_META)) expect(routes, path).toContain(path);
    expect(PAGE_META['/']).toBe(HOME);
  });

  it('fit in a search result: titles up to 60 characters with the brand, descriptions 110-160', () => {
    for (const [path, page] of pages) {
      expect(page.title.length, `${path}: ${page.title}`).toBeLessThanOrEqual(60);
      expect(page.title, path).toMatch(/\bcubr\b/);
      expect(page.description.length, `${path}: ${page.description}`).toBeGreaterThanOrEqual(110);
      expect(page.description.length, `${path}: ${page.description}`).toBeLessThanOrEqual(160);
      expect(page.heading.length, path).toBeGreaterThan(0);
      // the site's voice, lowercase; csTimer keeps its own spelling
      for (const text of [page.title, page.description, page.heading])
        expect(text.replace(/csTimer/g, ''), path).toBe(text.replace(/csTimer/g, '').toLowerCase());
    }
    // the brand last, as search results expect; the home page leads with it, About says it in its sentence
    for (const [path, page] of pages) if (path !== '/' && path !== '/about') expect(page.title, path).toMatch(/ \| cubr$/);
    expect(HOME.title).toMatch(/^cubr \| /);
  });

  it('are each their own: no two pages share a title or a description', () => {
    expect(new Set(pages.map(([, p]) => p.title)).size).toBe(pages.length);
    expect(new Set(pages.map(([, p]) => p.description)).size).toBe(pages.length);
  });

  it('say what cubr is for in the words cubers search: speedcube, cube, timer and their family', () => {
    for (const [path, page] of pages) expect(focusWords(`${page.title} ${page.description}`).length, path).toBeGreaterThan(0);
    // the home page: the phrases themselves
    expect(HOME.title).toContain('cube timer');
    expect(HOME.title).toMatch(/speedcubers/);
    expect(HOME.description).toContain('speedcube timer');
    expect(HOME.heading).toContain('speedcube timer');
    for (const word of ['cubers', 'speedcubers']) expect(focusWords(HOME.description).map((w) => w.toLowerCase())).toContain(word);
  });

  it('never stuff them: each word once in a title (three at most), twice in a description (five at most)', () => {
    const most = (words: string[]) => Math.max(0, ...[...new Set(words)].map((w) => words.filter((x) => x === w).length));
    for (const [path, page] of pages) {
      const inTitle = focusWords(page.title).map((w) => w.toLowerCase());
      const inDescription = focusWords(page.description).map((w) => w.toLowerCase());
      expect(inTitle.length, `${path}: ${page.title}`).toBeLessThanOrEqual(3);
      expect(most(inTitle), `${path}: ${page.title}`).toBeLessThanOrEqual(1);
      expect(inDescription.length, `${path}: ${page.description}`).toBeLessThanOrEqual(5);
      expect(most(inDescription), `${path}: ${page.description}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('index.html, the home page', () => {
  const h = head(indexHtml);

  it("has the home page's title and description, for search engines and link previews", () => {
    expect(h.title).toBe(HOME.title);
    expect(h.description).toBe(HOME.description);
    expect(h.ogDescription).toBe(HOME.description);
    // link previews keep the plain name as their title, on every page
    expect(h.ogTitle).toBe('cubr');
    expect(h.ogSiteName).toBe('cubr');
  });

  it("carries a summary for crawlers that don't run the app, inside #root so the app replaces it", () => {
    expect(indexHtml).toMatch(/<div id="root">\s*<div id="page-summary"/);
    expect(h.heading).toBe(HOME.heading);
    expect(h.line).toBe(HOME.description);
    // links to the public pages, by the names the app uses
    expect(h.links.length).toBeGreaterThanOrEqual(5);
    for (const [href] of h.links) expect(Object.keys(PAGE_META), href).toContain(href);
  });

  it('hides the summary until the app replaces it, so nothing flashes or shifts: out of the flow, 1 px, clipped', () => {
    const style = h.summaryStyle;
    expect(style).toMatch(/style="[^"]*position: absolute/);
    expect(style).toMatch(/width: 1px; height: 1px/);
    expect(style).toMatch(/overflow: hidden; clip: rect\(0, 0, 0, 0\)/);
    // a style attribute, not a <style> element (the CSP refuses those), and never display: none,
    // which text-only crawlers can take as "not part of the page"
    expect(indexHtml.replace(/<!--[\s\S]*?-->/g, '')).not.toMatch(/<style[\s>]/);
    expect(style).not.toMatch(/display: ?none|visibility: ?hidden/);
  });

  it('tells a browser without JavaScript what cubr is', () => {
    expect(indexHtml).toMatch(/<noscript><p[^>]*>cubr is a speedcube timer that runs in your browser[^<]*<\/p><\/noscript>/);
  });
});

describe("each public page's own HTML (plugins/pageFiles.ts)", () => {
  it("is index.html with the page's title, description and heading, and nothing else changed", () => {
    for (const [path, page] of pages) {
      const html = pageHtml(indexHtml, page);
      const h = head(html);
      expect(h.title, path).toBe(page.title);
      expect(h.description, path).toBe(page.description);
      expect(h.ogDescription, path).toBe(page.description);
      expect(h.heading, path).toBe(page.heading);
      expect(h.line, path).toBe(page.description);
      expect(h.ogTitle, path).toBe('cubr');
      // putting the home page's back gives index.html exactly: only those five spots differ
      expect(pageHtml(html, HOME), path).toBe(indexHtml);
    }
    expect(pageHtml(indexHtml, HOME)).toBe(indexHtml);
  });

  it('escapes what it puts in', () => {
    const html = pageHtml(indexHtml, { title: 'a <b> & "c" | cubr', description: 'x < y & "z"', heading: '<h1>' });
    expect(html).toContain('<title>a &lt;b&gt; &amp; &quot;c&quot; | cubr</title>');
    expect(html).toContain('<meta name="description" content="x &lt; y &amp; &quot;z&quot;"');
    expect(html).toContain('<h1>&lt;h1&gt;</h1>');
    expect(head(html).title).toBe('a <b> & "c" | cubr');
  });

  it('refuses an index.html that has lost one of the spots, or has two, rather than write pages without', () => {
    expect(() => pageHtml(indexHtml.replace(/<title>[^<]*<\/title>/, ''), HOME)).toThrow(/<title>/);
    expect(() => pageHtml(indexHtml.replace('id="page-summary"', 'id="summary"'), HOME)).toThrow(/page-summary/);
    expect(() => pageHtml(indexHtml.replace('</head>', '<meta name="description" content="x" /></head>'), HOME)).toThrow(/description/);
  });

  it('goes to pages/<path>.html', () => {
    expect(pageFile('/daily')).toBe('pages/daily.html');
    expect(pageFile('/leaderboards')).toBe('pages/leaderboards.html');
  });
});

describe('what search results may quote', () => {
  // Google quotes page text instead of the description when it likes it better: before 1.6 it showed
  // "L' B R' L' F' ... 0.00. hold the timer, release to start" for cubr.dev. data-nosnippet keeps the
  // timer's and the tool pages' moving parts out of results (it doesn't change what's shown or indexed).
  const nosnippet = (source: string, className: string) => new RegExp(`className="${className}"[^>]*\\sdata-nosnippet`).test(source);

  it('never the timer: its scramble, time, hints and stats, while its heading stays quotable', () => {
    expect(nosnippet(timerSource, 'timer-page')).toBe(true);
    // the heading comes before (outside) the data-nosnippet block
    expect(timerSource.indexOf('<h1 className="sr-only">{HOME.heading}</h1>')).toBeLessThan(timerSource.indexOf('<div className="timer-page" data-nosnippet>'));
    expect(timerSource.indexOf('<h1 className="sr-only">')).toBeGreaterThan(0);
  });

  it("never the daily page's scrambles, countdown and board, or the race lobby's rooms and forms", () => {
    for (const c of ['daily-countdown', 'daily-config fade-on-focus', 'daily-layout']) expect(nosnippet(dailySource, c), c).toBe(true);
    for (const c of ['subtitle', 'race-lobby-grid']) expect(nosnippet(raceSource, c), c).toBe(true);
  });

  it("never the footer's links and buttons", () => {
    for (const c of ['footer-links', 'footer-right']) expect(nosnippet(layoutSource, c), c).toBe(true);
  });

  it("never the leaderboard's filters and table, the WCA page's event and country lists, or About's counters", () => {
    for (const c of ['lb-group lb-periods', 'lb-group lb-dates', 'lb-group lb-kinds', 'lb-group lb-events', 'lb-toolbar', 'table-wrap'])
      expect(nosnippet(leaderboardsSource, c), c).toBe(true);
    // the calculator, records and people search sit in one data-nosnippet block that keeps the layout
    expect(wcaSource).toMatch(/<div data-nosnippet style=\{\{ display: 'contents' \}\}>\s*\{tab === 'rank'/);
    expect(aboutSource).toMatch(/<section aria-label="live stats" data-nosnippet>/);
  });
});
