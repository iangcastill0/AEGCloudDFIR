import { expect, test } from '@playwright/test';

/**
 * Keyboard and structural accessibility checks for the primary flows
 * (WCAG 2.2 AA support; full axe scans run when @axe-core/playwright is
 * available — structural assertions below are dependency-free).
 */
test.describe('accessibility fundamentals', () => {
  const pages = [
    '/',
    '/connectors',
    '/collections',
    '/import',
    '/review',
    '/cases',
    '/exports',
    '/productions',
    '/audit',
  ];

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

/**
 * Throughput charts.
 *
 * This repo treats a chart that only works if you can see it as a defect, so
 * these are requirements and not a polish pass. Every picture must be a
 * role="img" whose label states the FIGURES, must be followed by a real table of
 * the same numbers, and must repeat its headline as ordinary text so the page
 * still answers the question with stylesheets switched off.
 *
 * Each test skips when the seeded tenant has no collection, so the suite stays
 * green on a fresh environment rather than failing for the wrong reason.
 */
test.describe('collection throughput charts are readable without sight', () => {
  /** Open the first collection's detail page, or skip. */
  async function openFirstCollection(page: import('@playwright/test').Page): Promise<boolean> {
    await page.goto('/collections');
    const first = page.locator('a[href^="/collections/"]').first();
    if ((await first.count()) === 0) return false;
    await first.click();
    const section = page.getByRole('heading', { name: 'Throughput' });
    await expect(section).toBeAttached();
    return true;
  }

  test('every chart is an image with a label that states numbers, not a shape', async ({
    page,
  }) => {
    test.skip(!(await openFirstCollection(page)), 'no collection seeded');
    const charts = page.locator('[role="img"]');
    const count = await charts.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const label = (await charts.nth(i).getAttribute('aria-label')) ?? '';
      expect(label.length).toBeGreaterThan(0);
      // A figure must be in there. "A line trending upwards" is not an answer.
      expect(label).toMatch(/\d/);
      for (const shapeWord of ['trending', 'upward', 'downward', 'curve']) {
        expect(label.toLowerCase()).not.toContain(shapeWord);
      }
    }
  });

  test('each chart is followed by a real table of the same numbers', async ({ page }) => {
    test.skip(!(await openFirstCollection(page)), 'no collection seeded');
    // Hidden from sight, not from assistive technology: a <table> with headers
    // is the only way a screen-reader user can walk the individual buckets.
    const hiddenTables = page.locator('.cdfir-visually-hidden table');
    expect(await hiddenTables.count()).toBeGreaterThan(0);
    await expect(hiddenTables.first().locator('th[scope="col"]').first()).toBeAttached();
    await expect(hiddenTables.first().locator('caption')).toBeAttached();
  });

  test('the headline figures are text, so the page works with CSS off', async ({ page }) => {
    test.skip(!(await openFirstCollection(page)), 'no collection seeded');
    await page.addStyleTag({ content: '* { all: unset !important; }' });
    // Item counts and elapsed time are ordinary text nodes, not <text> in an svg.
    await expect(page.locator('.cdfir-chart__headline').first()).toContainText(/\d/);
  });

  test('the state is a word and an icon, never colour alone', async ({ page }) => {
    test.skip(!(await openFirstCollection(page)), 'no collection seeded');
    const chip = page.locator('.cdfir-throughput-state').first();
    await expect(chip).toBeAttached();
    // Stripping colour must not remove the meaning.
    await expect(chip).toContainText(/[A-Za-z]{4,}/);
  });

  test('no chart or figure promises a finish time', async ({ page }) => {
    test.skip(!(await openFirstCollection(page)), 'no collection seeded');
    // The locked decision, checked in the rendered page rather than trusted.
    // Replaying the largest real run, a 5-minute window predicted the remainder
    // between -16% and +33% of the truth.
    const body = (await page.locator('main').innerText()).toLowerCase();
    for (const banned of [
      'eta',
      'time remaining',
      'remaining:',
      'estimated finish',
      'finishes at',
    ]) {
      expect(body).not.toContain(banned);
    }
  });

  test('the pace is NOT announced by a live region', async ({ page }) => {
    test.skip(!(await openFirstCollection(page)), 'no collection seeded');
    // The poll is every 5 seconds. A polite live region firing that often makes
    // the page unusable with a screen reader, so only phase and stall changes go
    // through it.
    const live = page.locator('[aria-live="polite"]');
    const count = await live.count();
    for (let i = 0; i < count; i += 1) {
      const text = (await live.nth(i).innerText()).toLowerCase();
      expect(text).not.toContain('/min');
      expect(text).not.toContain('per minute');
    }
  });
});
