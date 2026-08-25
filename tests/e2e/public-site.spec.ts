import { expect, test } from '@playwright/test';

const PAGES = ['/', '/download', '/docs', '/privacy'];

test.describe('public site', () => {
  for (const path of PAGES) {
    test(`${path} renders without console errors or localhost traffic`, async ({ page }) => {
      const consoleErrors: string[] = [];
      const localhostRequests: string[] = [];

      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(String(error)));
      page.on('request', (request) => {
        // The workspace shell polls a local HII runtime. A visitor's browser has
        // nothing listening there, and an HTTPS page cannot reach it anyway, so
        // a public page must never ask.
        if (/127\.0\.0\.1|localhost/.test(request.url())) localhostRequests.push(request.url());
      });

      const response = await page.goto(path);
      expect(response?.status(), `${path} status`).toBe(200);
      await expect(page.locator('h1')).toBeVisible();

      expect(localhostRequests, `${path} requested a local runtime`).toEqual([]);
      expect(consoleErrors, `${path} logged errors`).toEqual([]);
    });
  }

  test('/ is the landing page, not the workspace shell', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Your context');
    await expect(page.locator('.public-landing')).toBeVisible();
  });

  test('a page taller than the viewport actually scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');

    const surface = page.locator('.public-home');
    const overflows = await surface.evaluate((node) => node.scrollHeight > node.clientHeight + 1);
    expect(overflows, 'landing page should be taller than the viewport').toBe(true);

    await surface.evaluate((node) => node.scrollTo(0, 600));
    // html/body are overflow:hidden for the canvas app, so if the public page is
    // not its own scroll container the content is simply clipped and unreachable.
    expect(await surface.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  });

  test('the footer of the landing page is reachable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    const footerLink = page.locator('nav a', { hasText: 'Privacy' });
    await footerLink.scrollIntoViewIfNeeded();
    await expect(footerLink).toBeInViewport();
  });

  test('the Windows download serves a real installer', async ({ request }) => {
    const response = await request.head('/download/windows');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-disposition']).toContain('.exe');
    expect(Number(response.headers()['content-length'])).toBeGreaterThan(1_000_000);
  });

  test('an unknown path is a 404, not a blank page', async ({ page }) => {
    const response = await page.goto('/definitely-not-a-page');
    expect(response?.status()).toBe(404);
  });
});
