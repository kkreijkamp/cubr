import { expect, test } from '@playwright/test';
import { AUTH_FILE, solveWithSpace } from './helpers';

test.use({ storageState: AUTH_FILE });

// A daily attempt is recorded by the server: it is still there after a reload.
test('a daily attempt is saved', async ({ page }) => {
  await page.goto('/daily');
  const filled = page.locator('.daily-strip li.filled');
  await expect(page.locator('.daily-strip')).toBeVisible();
  await expect(page.locator('.daily-strip li.current')).toHaveCount(1); // today's scrambles came, one is up
  const before = await filled.count();
  await solveWithSpace(page, 2600);
  await expect(filled).toHaveCount(before + 1);
  await expect(page.locator('.daily-strip li.failed')).toHaveCount(0);

  await page.reload();
  await expect(filled).toHaveCount(before + 1);
  // today's times are buttons that pick the attempt for ok / +2 / dnf
  await expect(page.getByRole('button', { name: new RegExp(`^attempt ${before + 1}: \\d+\\.\\d\\d`) })).toBeVisible();
});
