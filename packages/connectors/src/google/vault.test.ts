import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProviderServer, type FakeProviderServer } from '../fake-server.js';
import { StaticTokenProvider } from '../oauth.js';
import { GoogleVaultConnector } from './vault.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));
const TOKEN = 'fake-token-do-not-log';

let server: FakeProviderServer;

beforeAll(async () => {
  server = await startFakeProviderServer(FIXTURES);
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  server.reset();
});

function connector(vaultMatterIds?: readonly string[]) {
  return new GoogleVaultConnector({
    tokenProvider: new StaticTokenProvider(TOKEN),
    vaultBaseUrl: `${server.url}/google/vault`,
    vaultMatterIds,
    sleepImpl: () => Promise.resolve(),
  });
}

describe('GoogleVaultConnector.listAuditScopes', () => {
  it('maps open matters to scopes', async () => {
    const scopes = await connector().listAuditScopes();
    expect(scopes).toEqual([
      { scopeKey: 'matter-001', label: 'Acme Litigation Hold' },
      { scopeKey: 'matter-002', label: 'Internal Investigation 2026' },
    ]);
    const req = server.requests.find((r) => r.path.endsWith('/v1/matters'));
    expect(req?.query['state']).toBe('OPEN');
  });

  it('filters to the configured matter ids', async () => {
    const scopes = await connector(['matter-002']).listAuditScopes();
    expect(scopes).toEqual([{ scopeKey: 'matter-002', label: 'Internal Investigation 2026' }]);
  });
});

describe('GoogleVaultConnector.fetchAuditPage', () => {
  it('turns each COMPLETED export into a metadata-only batch and skips others', async () => {
    const page = await connector().fetchAuditPage('matter-001', {});
    expect(page.batches).toHaveLength(1); // export-002 (IN_PROGRESS) is skipped
    const batch = page.batches[0];
    expect(batch?.system).toBe('google_vault');
    expect(batch?.batchId).toBe('export-001');
    expect(batch?.scopeKey).toBe('matter-001');
    expect(batch?.providerReportedCount).toBe(1);
    expect(batch?.records).toHaveLength(1);

    const rec = batch?.records[0];
    expect(rec).toMatchObject({
      providerRecordId: 'export-001',
      operation: 'vault_export',
      workload: 'vault',
      recordType: 'vault_export',
      occurredAt: '2026-07-02T15:00:00.000Z',
    });
    // raw carries the full export descriptor (metadata only).
    const raw = rec?.raw as { id?: string; status?: string; cloudStorageSink?: unknown };
    expect(raw.id).toBe('export-001');
    expect(raw.status).toBe('COMPLETED');
    expect(raw.cloudStorageSink).toBeDefined();

    // rawBytes decode to the export descriptor, not archive bytes.
    const decoded = JSON.parse(new TextDecoder().decode(batch?.rawBytes)) as { id: string };
    expect(decoded.id).toBe('export-001');
  });

  it('is strictly read-only: only GET requests are issued', async () => {
    const c = connector();
    await c.listAuditScopes();
    await c.fetchAuditPage('matter-001', {});
    expect(server.requests.length).toBeGreaterThan(0);
    expect(server.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('never leaks the bearer token in error messages', async () => {
    const bad = new GoogleVaultConnector({
      tokenProvider: new StaticTokenProvider(TOKEN),
      vaultBaseUrl: `${server.url}/google/vault`,
      sleepImpl: () => Promise.resolve(),
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 500 })),
    });
    try {
      await bad.fetchAuditPage('matter-001', {});
      throw new Error('expected failure');
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});
