// Vite plugin: writes each public page's own copy of index.html, pages/<path>.html, with that page's
// title, description and heading (src/lib/pageMeta.ts) in place of the home page's. nginx serves it at
// the page's address (web/nginx/default.conf.template: try_files /pages$uri.html), so crawlers that
// don't run the app (AI search engines, link previews, and Bing at times) read what each page is
// about. In a browser the app starts as on any page and replaces the summary. The service worker
// doesn't cache these files (src/sw/policy.ts): the app it opens offline sets the same title and
// description itself.
import type { Plugin } from 'vite';
import { HOME, PAGE_META, type PageMeta } from '../src/lib/pageMeta';

/** Where the build writes a public page's HTML, inside dist/. */
export function pageFile(path: string): string {
  return `pages${path}.html`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * index.html with a page's title, description (the search engines' and the link preview's) and the
 * summary's heading and line in place of the home page's. Everything else stays as it is. Throws if
 * index.html no longer has exactly one of each, so a change there can't quietly leave pages without.
 */
export function pageHtml(indexHtml: string, page: PageMeta): string {
  const swaps: [RegExp, string][] = [
    [/(<title>)[^<]*(<\/title>)/, page.title],
    [/(<meta name="description" content=")[^"]*(")/, page.description],
    [/(<meta property="og:description" content=")[^"]*(")/, page.description],
    [/(<div id="page-summary"[^>]*>\s*<h1>)[^<]*(<\/h1>)/, page.heading],
    [/(<div id="page-summary"[^>]*>\s*<h1>[^<]*<\/h1>\s*<p>)[^<]*(<\/p>)/, page.description],
  ];
  let html = indexHtml;
  for (const [pattern, text] of swaps) {
    const found = html.match(new RegExp(pattern.source, 'g'))?.length ?? 0;
    if (found !== 1) throw new Error(`index.html should have exactly one ${pattern.source}, and has ${found}`);
    html = html.replace(pattern, (_, before: string, after: string) => `${before}${escapeHtml(text)}${after}`);
  }
  return html;
}

export function pageFiles(): Plugin {
  return {
    name: 'cubr-page-files',
    apply: 'build',
    // after Vite has put the built index.html (with its script and stylesheet tags) in the bundle
    enforce: 'post',
    generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (index?.type !== 'asset') return this.error('index.html is not in the bundle');
      const html = typeof index.source === 'string' ? index.source : new TextDecoder().decode(index.source);
      for (const [path, page] of Object.entries(PAGE_META)) {
        if (page === HOME) continue; // the home page is index.html itself
        this.emitFile({ type: 'asset', fileName: pageFile(path), source: pageHtml(html, page) });
      }
    },
  };
}
