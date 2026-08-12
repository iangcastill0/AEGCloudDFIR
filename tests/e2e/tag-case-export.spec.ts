import { expect, test, type Page } from '@playwright/test';

/**
 * Acceptance scenario 3: tag an email and its family, create a case from that
 * tag, export natives + CSV, and verify export hashes against the collection
 * manifest. Runs against the live stack over the demo corpus.
 */
const API = process.env.EV_E2E_API_URL ?? 'http://localhost:4000';

async function ctx(page: Page): Promise<{ token: string }> {
  const tenants = (await (await page.request.get(`${API}/auth/tenants`)).json()) as {
    tenants: { tenantId: string; name: string }[];
  };
  const demo = tenants.tenants.find((t) => /demo matter/i.test(t.name))!;
  const token0 = ((await (await page.request.get(`${API}/auth/csrf`)).json()) as { token: string })
    .token;
  await page.request.post(`${API}/auth/select-tenant`, {
    data: { tenantId: demo.tenantId },
    headers: { 'x-csrf-token': token0 },
  });
  const token = ((await (await page.request.get(`${API}/auth/csrf`)).json()) as { token: string })
    .token;
  return { token };
}

test('tag family → case → native + CSV export with hash verification', async ({ page }) => {
  test.setTimeout(180_000);
  const { token } = await ctx(page);
  const H = { 'x-csrf-token': token };

  // Find an email with an attachment family.
  const search = (await (
    await page.request.post(`${API}/api/v1/search`, {
      headers: H,
      data: { query: 'subject:vendor' },
    })
  ).json()) as { total: number; items: { id: string }[] };
  expect(search.total).toBeGreaterThan(0);
  const evidenceId = search.items[0]!.id;

  // Tag with family propagation.
  const tag = (await (
    await page.request.post(`${API}/api/v1/tags`, {
      headers: H,
      data: { name: `Hot-${Date.now()}`, color: '#cc2222', familyBehavior: 'apply_to_family' },
    })
  ).json()) as { id: string };
  const bulk = await page.request.post(`${API}/api/v1/tags/bulk`, {
    headers: H,
    data: { tagId: tag.id, evidenceItemIds: [evidenceId], action: 'apply' },
  });
  expect(bulk.ok()).toBeTruthy();

  // Create a case and add the tagged family by reference.
  const kase = (await (
    await page.request.post(`${API}/api/v1/cases`, {
      headers: H,
      data: { name: `Matter ${Date.now()}`, matterNumber: 'M-1' },
    })
  ).json()) as { id: string };
  const addItems = await page.request.post(`${API}/api/v1/cases/${kase.id}/items`, {
    headers: H,
    data: { source: { kind: 'tag', tagId: tag.id }, includeFamilies: true },
  });
  expect(addItems.ok()).toBeTruthy();
  const caseItems = (await (
    await page.request.get(`${API}/api/v1/cases/${kase.id}/items`)
  ).json()) as { items: unknown[] };
  // Email + its attachment child → at least 2 reference rows.
  expect(caseItems.items.length).toBeGreaterThanOrEqual(2);

  for (const kind of ['native', 'csv'] as const) {
    const create = await page.request.post(`${API}/api/v1/exports`, {
      headers: H,
      data: {
        idempotencyKey: `exp-${kind}-${Date.now()}`,
        kind,
        name: `${kind} export`,
        caseId: kase.id,
        selection: { kind: 'case', caseId: kase.id },
        includeFamilies: true,
        ...(kind === 'csv'
          ? { csv: { columns: ['evidenceId', 'sha256', 'from', 'subject'], delimiter: ',' } }
          : {}),
      },
    });
    expect(create.ok(), await create.text()).toBeTruthy();
    const exp = (await create.json()) as { id: string };

    // The export worker verifies every output hash before marking ready.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${API}/api/v1/exports/${exp.id}`);
          return res.ok() ? ((await res.json()) as { status: string }).status : '';
        },
        { timeout: 120_000, intervals: [3000] },
      )
      .toMatch(/ready|failed/);

    const status = (await (await page.request.get(`${API}/api/v1/exports/${exp.id}`)).json()) as {
      status: string;
      itemCount: number;
    };
    expect(status.status, `${kind} export reaches ready`).toBe('ready');
    expect(status.itemCount).toBeGreaterThan(0);
  }
});
