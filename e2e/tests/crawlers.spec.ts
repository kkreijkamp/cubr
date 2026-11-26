import { expect, test } from '@playwright/test';

// What a crawler that doesn't run JavaScript gets (AI search, link previews, Bing at times): each public
// page's file, with the page's content prerendered into it when the web image was built
// (web/scripts/prerender.mjs). A page that lost it would only have its summary.
const CONTENT: Record<string, string[]> = {
  '/about': ['how does inspection work?', 'keyboard shortcuts'],
  '/privacy': ['how long we keep it', 'who helps us run cubr'],
  '/terms': ['fair play'],
};

for (const [path, phrases] of Object.entries(CONTENT))
  test(`a crawler without JavaScript reads ${path}'s content`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const html = await res.text();
    // from the content's start to the <noscript> after #root: the block and its nested markup, whole
    const from = html.indexOf('<div id="page-content">');
    const content = from < 0 ? '' : html.slice(from, html.indexOf('<noscript>', from));
    for (const phrase of phrases) expect(content, `${path}: "${phrase}"`).toContain(phrase);
    expect(content).not.toMatch(/<(script|style|svg|button|input)\b/); // text and links only
  });
