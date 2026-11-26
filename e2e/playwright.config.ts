import { defineConfig, devices } from '@playwright/test';

// End-to-end and accessibility tests of a running stack: locally `docker compose up -d --wait` from
// the repo root, then `npm test` here; CI does the same (the "End-to-end" job). CUBR_URL points
// them elsewhere. The setup project signs one account up; the specs that need it reuse its storage.
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.CUBR_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /\.setup\.ts$/, use: process.env.CI ? {} : { channel: 'chrome' } },
    {
      name: 'chromium',
      // CI installs Playwright's Chromium; a local run uses the Google Chrome already installed
      // (a throwaway profile, nothing to download)
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, ...(process.env.CI ? {} : { channel: 'chrome' }) },
      dependencies: ['setup'],
    },
  ],
});
