import { expect, test } from '@playwright/test';
import { quiet, solveWithSpace } from './helpers';

// Two guests in two browsers: one makes a room, the other joins with its link, they race a round.
test('two players race a round', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await quiet(host);
  await quiet(guest);

  await host.goto('/race');
  await host.getByLabel('name', { exact: true }).fill('e2e race');
  await host.getByRole('button', { name: /create & join/ }).click();
  await expect(host).toHaveURL(/\/race\/[^/?#]+$/);
  await guest.goto(host.url());

  const standings = (p: typeof host) => p.locator('.race-standings tbody tr');
  await expect(standings(host)).toHaveCount(2);
  await expect(standings(guest)).toHaveCount(2);

  await host.getByRole('button', { name: 'start round 1' }).click();
  // the round reached both: each is told to start
  for (const p of [host, guest]) await expect(p.getByText('hold space, release to start')).toBeVisible();
  await Promise.all([solveWithSpace(host, 2200), solveWithSpace(guest, 2700)]);

  // the round is over for both, and each sees both results
  await expect(host.getByText(/round finished/)).toBeVisible();
  await expect(guest.getByText(/round finished/)).toBeVisible();
  for (const p of [host, guest]) await expect(p.locator('.race-grid tbody')).toContainText(/\d+\.\d\d[\s\S]*\d+\.\d\d/);
});
