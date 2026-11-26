import { expect, test, type Page } from '@playwright/test';
import { AUTH_FILE, quiet, signedUpUser } from './helpers';

// The responsive audit (v1.4.10) as a test: every main page at 320 px (the narrowest WCAG's reflow asks
// for, as the accessibility statement says), a phone, a tablet and a desktop, and none scrolls sideways.
const WIDTHS = [320, 390, 768, 1280];
const PAGES = ['/', '/daily', '/leaderboards', '/race', '/wca', '/about', '/settings', '/login', '/login?mode=signup', '/privacy', '/terms', '/no-such-page'];

/**
 * What reaches past the right edge. The app clips sideways overflow (.app's overflow-x: clip, so a stray
 * tooltip can't make the page scroll), which would hide such content instead: so this looks at the
 * elements themselves, not only the page's width. Tooltips (positioned), invisible and empty elements, and
 * anything inside a box that scrolls or clips sideways on purpose (a wide table's box) don't count.
 */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    if (document.documentElement.scrollWidth > width + 1) out.push(`page ${document.documentElement.scrollWidth} px wide in ${width}`);
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= width + 1) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'absolute' || cs.position === 'fixed' || cs.visibility === 'hidden') continue;
      let held = false;
      for (let p = el.parentElement; p && !held && !p.classList.contains('app'); p = p.parentElement)
        held = ['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(p).overflowX);
      if (!held) out.push(`${el.tagName.toLowerCase()}.${String(el.className)}`.slice(0, 80) + ` to ${Math.round(r.right)} px`);
      if (out.length > 5) break;
    }
    return out;
  });
}

async function check(page: Page, path: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('h1').first()).toBeAttached();
  expect(await overflow(page), `${path} at ${width} px`).toEqual([]);
}

for (const path of PAGES)
  test(`no sideways scroll: ${path}`, async ({ page }) => {
    await quiet(page);
    for (const width of WIDTHS) await check(page, path, width);
  });

test.describe('signed in', () => {
  test.use({ storageState: AUTH_FILE });
  test('no sideways scroll: settings and the profile, signed in', async ({ page }) => {
    for (const path of ['/settings', `/profile/${signedUpUser().username}`]) for (const width of WIDTHS) await check(page, path, width);
  });
});
