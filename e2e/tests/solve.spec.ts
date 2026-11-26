import { expect, test } from '@playwright/test';
import { AUTH_FILE, signedUpUser, solveWithSpace } from './helpers';

test.use({ storageState: AUTH_FILE });

// A solve on the timer page reaches the solve service, and through its event the leaderboards.
test('a solve is kept and ranks on the all-time board', async ({ page }) => {
  const { username } = signedUpUser();
  await page.goto('/');
  await expect(page.locator('.tp-scramble')).toBeVisible();
  await expect(page.locator('.tp-scramble-loading')).toHaveCount(0);
  const before = await page.locator('.tp-solve-row').count();
  await solveWithSpace(page, 2600);
  await expect(page.locator('.tp-solve-row')).toHaveCount(before + 1);
  await expect(page.getByRole('option', { name: new RegExp(`^solve ${before + 1}: \\d+\\.\\d\\d`) })).toHaveCount(1);

  // the 3x3 single board, all-time: the event reaches the leaderboard service within seconds
  await expect
    .poll(
      async () => {
        await page.goto('/leaderboards?event=333&period=all&kind=single');
        await page.waitForLoadState('networkidle');
        return page.getByText(username, { exact: true }).count();
      },
      { timeout: 45_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBeGreaterThan(0);
});
