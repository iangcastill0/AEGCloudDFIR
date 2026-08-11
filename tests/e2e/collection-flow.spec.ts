import { expect, test } from '@playwright/test';

/**
 * Acceptance scenario 1 (demo mode): run a collection against the seeded
 * fake-provider Microsoft account with a bounded date range, then observe
 * progress and an honest completeness state with a manifest.
 *
 * Prerequisites: demo seed applied, fake provider on :4010, api+worker
 * running with provider base URLs pointed at the fake server.
 */
test.describe('collection wizard → run → completeness (scenario 1)', () => {
  test('wizard walks 8 steps and starts a collection', async ({ page }) => {
    await page.goto('/auth/tenant');
    const demoTenant = page.getByRole('button', { name: /demo matter workspace/i }).first();
    if (await demoTenant.isVisible().catch(() => false)) await demoTenant.click();

    await page.goto('/collections/new');

    // Step 1: provider
    await page.getByRole('radio', { name: /microsoft/i }).check();
    await page.getByRole('button', { name: /next/i }).click();

    // Step 2: account — the seeded fake connector
    await page.getByText(/demo microsoft account/i).first().click();
    await page.getByRole('button', { name: /next/i }).click();

    // Step 3: source
    await page.getByRole('checkbox', { name: /email/i }).check();
    await page.getByRole('button', { name: /next/i }).click();

    // Step 4: custodian — delegated self, with the truthfulness notice visible
    await expect(page.getByText(/delegated access does not make/i)).toBeVisible();
    await page.getByRole('button', { name: /next/i }).click();

    // Step 5: scope — bounded date range with explicit timezone
    await page.getByRole('radio', { name: /date range/i }).check();
    await page.getByLabel(/start date/i).fill('2024-01-01');
    await page.getByLabel(/end date/i).fill('2026-12-31');
    await page.getByLabel(/timezone/i).selectOption('UTC');
    await page.getByRole('button', { name: /next/i }).click();

    // Step 6: type
    await page.getByRole('radio', { name: /snapshot/i }).check();
    await page.getByRole('button', { name: /next/i }).click();

    // Step 7: review — honest limitation copy present
    await expect(page.getByText(/exceptions/i).first()).toBeVisible();
    await page.getByRole('button', { name: /next|review/i }).click();

    // Step 8: start
    await page.getByRole('button', { name: /start collection/i }).click();
    await page.waitForURL(/\/collections\//, { timeout: 20_000 });
  });

  test('collection reaches a qualified completeness state with manifest', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/collections');
    await page.getByRole('link', { name: /view|details/i }).first().click();

    // Poll the status page until a terminal state shows.
    const banner = page.locator('[data-completeness], [class*=completeness]').first();
    await expect
      .poll(
        async () => ((await banner.textContent().catch(() => '')) ?? '').toLowerCase(),
        { timeout: 180_000, intervals: [3000] },
      )
      .toMatch(/complete_within_selected_api_scope|complete_with_exceptions|partial/);

    // Never an unqualified "complete" label.
    const text = (await banner.textContent()) ?? '';
    expect(/\bcomplete\b(?!_)/i.test(text.replace(/complete_with|complete_within/gi, ''))).toBe(
      false,
    );

    await expect(page.getByRole('link', { name: /manifest/i })).toBeVisible();
  });
});
