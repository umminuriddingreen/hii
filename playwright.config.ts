import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the public site.
 *
 * The unit suite runs in jsdom and cannot see the two failures that actually
 * shipped: a page that fetches a localhost runtime it will never reach from
 * HTTPS, and a page that renders but does not scroll because html/body are
 * locked to the viewport for the canvas app. Both need a real browser.
 *
 * Defaults to the deployed preview. Point HII_SITE_URL at any deployment —
 * production, a local `wrangler dev` — to check that one instead.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.HII_SITE_URL || 'https://hii-site-preview.ummingreen.workers.dev',
    trace: 'on-first-retry'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
