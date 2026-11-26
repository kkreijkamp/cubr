import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

/** The account the setup project signs up, and its saved storage (gitignored). */
export const AUTH_FILE = new URL('../.auth/user.json', import.meta.url).pathname;
export const USER_FILE = new URL('../.auth/user.meta.json', import.meta.url).pathname;
export const signedUpUser = (): { username: string } => JSON.parse(readFileSync(USER_FILE, 'utf8'));

/** A username nobody has yet: 3-20 letters, digits or _. */
export const uniqueName = (prefix = 'e2e') => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 20);

/** No "you're a guest" hint over the page. */
export const quiet = (page: Page) =>
  page.addInitScript(() => {
    localStorage.setItem('cubr.guestHintDismissed', '1');
  });

/**
 * One solve with the space bar, as a person does it: hold until the timer is ready (300 ms by
 * default), release to start, stop after `ms` (above the anti-cheat floor: 1.8 s for 3x3).
 */
export async function solveWithSpace(page: Page, ms = 2500): Promise<void> {
  const display = page.locator('.timer-display');
  await page.keyboard.down('Space');
  await expect(display).toHaveClass(/\bready\b/);
  await page.keyboard.up('Space');
  await expect(display).toHaveClass(/\brunning\b/);
  await page.waitForTimeout(ms);
  await page.keyboard.down('Space');
  await expect(display).not.toHaveClass(/\brunning\b/);
  await page.keyboard.up('Space');
}
