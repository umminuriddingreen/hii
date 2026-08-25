import { expect, test } from '@playwright/test';

/** Unique per run, so a rerun is never testing a row an earlier run wrote. */
function throwawayEmail() {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@hii-e2e.invalid`;
}

test.describe('waitlist', () => {
  test('a person can join from the building page', async ({ page }) => {
    await page.goto('/building');

    await page.getByRole('radio', { name: 'Memory Dock' }).check();
    await page.getByLabel('Email').fill(throwawayEmail());
    await page.getByLabel('What would you point it at? (optional)').fill('an e2e run');
    await page.getByRole('button', { name: 'Join the waitlist' }).click();

    await expect(page.getByRole('status')).toContainText('on the list');
  });

  test('a bad address is refused with a message, not a silent failure', async ({ page }) => {
    await page.goto('/building');
    // Bypass the browser's own type=email validation to exercise the server's.
    const response = await page.request.post('/api/waitlist', {
      data: { email: 'not-an-address' }
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain('email address');
  });

  test('signing up twice is not an error', async ({ request }) => {
    const email = throwawayEmail();
    const first = await request.post('/api/waitlist', { data: { email } });
    const second = await request.post('/api/waitlist', { data: { email } });
    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
  });

  test('the endpoint refuses cross-origin writes', async ({ request }) => {
    const response = await request.post('/api/waitlist', {
      headers: { origin: 'https://not-hii.example' },
      data: { email: throwawayEmail() }
    });
    expect(response.status()).toBe(403);
  });

  test('the endpoint refuses reads', async ({ request }) => {
    expect((await request.get('/api/waitlist')).status()).toBe(405);
  });
});
