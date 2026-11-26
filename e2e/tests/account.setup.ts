import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { AUTH_FILE, USER_FILE, quiet, uniqueName } from './helpers';

// Sign-up, the way a visitor does it; the specs that need an account reuse this one.
setup('sign up', async ({ page }) => {
  const username = uniqueName();
  await quiet(page);
  await page.goto('/login?mode=signup');
  await page.getByPlaceholder('username', { exact: true }).fill(username);
  await page.getByPlaceholder('email', { exact: true }).fill(`${username}@example.com`);
  await page.getByPlaceholder('password (8+ characters)', { exact: true }).fill(`e2e-${crypto.randomUUID()}`);
  await page.getByRole('button', { name: 'create account' }).click();
  // signed in: welcomed, and the header names the account
  await expect(page.getByText(`welcome to cubr, ${username}!`)).toBeVisible();
  await expect(page.getByRole('link', { name: `${username} account` })).toBeVisible();
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
  writeFileSync(USER_FILE, JSON.stringify({ username }));
});
