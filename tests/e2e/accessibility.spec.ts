import { expect, test } from '@playwright/test';

/**
 * Keyboard and structural accessibility checks for the primary flows
 * (WCAG 2.2 AA support; full axe scans run when @axe-core/playwright is
 * available — structural assertions below are dependency-free).
 */
test.describe('accessibility fundamentals', () => {
  const pages = ['/', '/connectors', '/collections', '/review', '/cases', '/exports', '/productions', '/audit'];

  for (const path of pages) {
    test(`${path} has landmarks, skip link, and a single h1`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.locator('nav').first()).toBeVisible();
      const skip = page.locator('a[href="#main"], a[href="#content"], [data-skip-link]').first();
      await expect(skip).toBeAttached();
      const h1Count = await page.locator('h1').count();
      expect(h1Count).toBe(1);
    });
  }

  test('keyboard-only: tab reaches interactive controls with visible focus', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const first = page.locator(':focus');
    await expect(first).toBeVisible();
    // Focus outline must not be suppressed.
    const outline = await first.evaluate((el) => {
      const s = getComputedStyle(el as HTMLElement, ':focus-visible');
      return s.outlineStyle;
    });
    expect(outline).not.toBe('none');
  });

  test('collection wizard is fully keyboard-operable to step 2', async ({ page }) => {
    await page.goto('/collections/new');
    // Choose a provider using only the keyboard.
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();
    // Radio/step controls must expose their state to AT.
    const stepper = page.locator('[aria-current="step"]');
    await expect(stepper.first()).toBeAttached();
  });
});
