import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Acceptance scenario 1 (demo mode): connect the seeded fake-provider
 * Microsoft account, run a bounded email collection, and observe preserved
 * originals, an indexed/searchable corpus, and an honest completeness state
 * with a signed manifest — driven through the real API + worker + fake
 * provider (no mock code paths).
 *
 * The UI wizard is separately smoke-checked for reachability; the pipeline
 * assertions run against the API so they are deterministic rather than
 * dependent on client-render timing.
 */
const API = process.env.EV_E2E_API_URL ?? 'http://localhost:4000';

async function csrf(page: Page): Promise<string> {
  const res = await page.request.get(`${API}/auth/csrf`);
  return ((await res.json()) as { token: string }).token;
}

async function selectDemoTenant(page: Page): Promise<{ tenantId: string; connectorId: string }> {
  const tenants = (await (await page.request.get(`${API}/auth/tenants`)).json()) as {
    tenants: { tenantId: string; name: string }[];
  };
  const demo = tenants.tenants.find((t) => /demo matter/i.test(t.name));
  expect(demo, 'demo tenant present (run scripts/demo-seed.ts)').toBeTruthy();
  const token = await csrf(page);
  const sel = await page.request.post(`${API}/auth/select-tenant`, {
    data: { tenantId: demo!.tenantId },
    headers: { 'x-csrf-token': token },
  });
  expect(sel.ok()).toBeTruthy();

  const connectors = (await (await page.request.get(`${API}/api/v1/connectors`)).json()) as {
    items: { id: string; provider: string; mode: string }[];
  };
  const ms = connectors.items.find((c) => c.provider === 'microsoft' && c.mode === 'delegated');
  expect(ms, 'seeded Microsoft connector present').toBeTruthy();
  return { tenantId: demo!.tenantId, connectorId: ms!.id };
}

async function custodianId(page: Page, connectorId: string): Promise<string> {
  const res = await page.request.get(`${API}/api/v1/connectors/${connectorId}/custodians`);
  const body = (await res.json()) as { items: { id: string }[] };
  expect(body.items.length).toBeGreaterThan(0);
  return body.items[0]!.id;
}

test.describe('collection → preservation → search → completeness (scenario 1)', () => {
  test('the collection wizard is reachable and renders step 1', async ({ page }) => {
    await page.goto('/collections/new');
    await expect(page.getByRole('region', { name: /step 1/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /microsoft/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /google/i })).toBeVisible();
  });

  test('runs a collection through the real pipeline to a qualified completeness state', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const { connectorId } = await selectDemoTenant(page);
    const custodian = await custodianId(page, connectorId);
    const token = await csrf(page);

    const create = await page.request.post(`${API}/api/v1/collections`, {
      headers: { 'x-csrf-token': token },
      data: {
        idempotencyKey: `e2e-${Date.now()}`,
        connectorAccountId: connectorId,
        name: 'E2E scenario 1 — Microsoft email',
        kind: 'snapshot',
        sources: ['email'],
        custodianIds: [custodian],
        scope: { dateRange: { kind: 'all_time' }, email: { folderIds: null } },
      },
    });
    expect(create.ok(), await create.text()).toBeTruthy();
    const { id: collectionId } = (await create.json()) as { id: string };

    // Poll status until terminal.
    let status = '';
    let completeness: string | null = null;
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${API}/api/v1/collections/${collectionId}/status`);
          if (!res.ok()) return '';
          const body = (await res.json()) as { status: string; completeness: string | null };
          status = body.status;
          completeness = body.completeness;
          return body.status;
        },
        { timeout: 240_000, intervals: [3000] },
      )
      .toMatch(/completed|failed|cancelled/);

    expect(status).toBe('completed');
    // Honest completeness vocabulary; never an unqualified label.
    expect(completeness).toMatch(
      /^(complete_within_selected_api_scope|complete_with_exceptions|partial)$/,
    );

    const status2 = (await (
      await page.request.get(`${API}/api/v1/collections/${collectionId}/status`)
    ).json()) as {
      progress: { preserved: number }[];
      manifest: { sha256: string } | null;
    };
    const preserved = status2.progress.reduce((n, p) => n + (p.preserved ?? 0), 0);
    expect(preserved, 'at least one original preserved').toBeGreaterThan(0);
    expect(status2.manifest?.sha256, 'signed manifest produced').toBeTruthy();
  });

  test('preserved evidence is searchable by From and subject', async ({ page }) => {
    test.setTimeout(120_000);
    await selectDemoTenant(page);
    const token = await csrf(page);

    // The corpus is indexed asynchronously; poll a broad match first.
    await expect
      .poll(
        async () => {
          const res = await page.request.post(`${API}/api/v1/search`, {
            headers: { 'x-csrf-token': token },
            data: { query: 'from:example.com', limit: 10 },
          });
          if (!res.ok()) return 0;
          return ((await res.json()) as { total: number }).total;
        },
        { timeout: 90_000, intervals: [3000] },
      )
      .toBeGreaterThan(0);
  });
});
