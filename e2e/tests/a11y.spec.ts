import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { AUTH_FILE, quiet, signedUpUser } from './helpers';

// axe on the main pages: WCAG 2.2 at A and AA, and axe's best practices. Contrast is checked with the
// high-contrast setting on: some themes, the default among them, have quieter labels and links told
// apart by colour (the accessibility statement on the About page says so, and points to the setting).
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const CONTRAST = ['color-contrast', 'link-in-text-block'];
const PAGES = ['/', '/daily', '/leaderboards', '/race', '/wca', '/about', '/settings', '/login', '/login?mode=signup', '/privacy', '/terms', '/no-such-page'];

async function scan(page: Page, path: string, rules: 'contrast' | 'the rest'): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('h1').first()).toBeAttached();
  const axe = new AxeBuilder({ page });
  const result = await (rules === 'contrast' ? axe.withRules(CONTRAST) : axe.withTags(TAGS).disableRules(CONTRAST)).analyze();
  const found = result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(found, `axe on ${path}`).toEqual([]);
}

for (const path of PAGES) {
  test(`axe: ${path}`, async ({ page }) => {
    await quiet(page);
    await scan(page, path, 'the rest');
  });
  test(`axe, contrast with high contrast on: ${path}`, async ({ page }) => {
    await quiet(page);
    await page.addInitScript(() => localStorage.setItem('cubr.settings', JSON.stringify({ highContrast: true })));
    await scan(page, path, 'contrast');
  });
}

test.describe('signed in', () => {
  test.use({ storageState: AUTH_FILE });
  for (const which of ['settings', 'profile'] as const)
    test(`axe: ${which}, signed in`, async ({ page }) => {
      await scan(page, which === 'settings' ? '/settings' : `/profile/${signedUpUser().username}`, 'the rest');
    });
});
