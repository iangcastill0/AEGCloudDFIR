import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProviderServer, type FakeProviderServer } from '../fake-server.js';
import { StaticTokenProvider } from '../oauth.js';
import { GraphAuditConnector, type GraphAuditScope } from './graph-audit.js';

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

function connector(scopes?: readonly GraphAuditScope[]) {
  return new GraphAuditConnector({
    tokenProvider: new StaticTokenProvider(TOKEN),
    graphBaseUrl: `${server.url}/graph`,
    scopes,
    sleepImpl: () => Promise.resolve(),
  });
}

describe('GraphAuditConnector.listAuditScopes', () => {
  it('returns both audit scopes by default', async () => {
    expect(await connector().listAuditScopes()).toEqual([
      { scopeKey: 'directoryAudits', label: 'directoryAudits' },
      { scopeKey: 'signIns', label: 'signIns' },
    ]);
  });

  it('filters to the enabled scopes', async () => {
    expect(await connector(['signIns']).listAuditScopes()).toEqual([
      { scopeKey: 'signIns', label: 'signIns' },
    ]);
  });
});

describe('GraphAuditConnector.fetchAuditPage directoryAudits', () => {
  it('formats the activityDateTime $filter and maps fields', async () => {
    const c = connector();
    const page = await c.fetchAuditPage('directoryAudits', {
      since: '2026-07-01T00:00:00Z',
      until: '2026-07-31T23:59:59Z',
    });

    const req = server.requests.find((r) => r.path.endsWith('/auditLogs/directoryAudits'));
    expect(req?.query['$filter']).toBe(
      'activityDateTime ge 2026-07-01T00:00:00Z and activityDateTime le 2026-07-31T23:59:59Z',
    );
    expect(req?.query['$top']).toBe('100');

    expect(page.batches).toHaveLength(1);
    const batch = page.batches[0];
    expect(batch?.system).toBe('graph_directory_audits');
    expect(batch?.batchId).toBe('directoryAudits:initial');
    expect(batch?.records[0]).toMatchObject({
      providerRecordId: 'da-1',
      operation: 'Add member to role',
      workload: 'RoleManagement',
      actorEmail: 'admin@example.com',
      actorId: 'u-1',
      targetId: 'u-2',
      targetType: 'User',
      resultStatus: 'success',
      occurredAt: '2026-07-01T10:00:00Z',
    });
    expect(page.nextCursor).toBeDefined();
  });

  it('follows @odata.nextLink and derives the batch id from the skiptoken', async () => {
    const c = connector();
    const first = await c.fetchAuditPage('directoryAudits', {});
    const second = await c.fetchAuditPage('directoryAudits', { cursor: first.nextCursor });
    expect(second.batches[0]?.batchId).toBe('directoryAudits:da2');
    expect(second.batches[0]?.records[0]?.providerRecordId).toBe('da-2');
    expect(second.nextCursor).toBeUndefined();
  });
});

describe('GraphAuditConnector.fetchAuditPage signIns', () => {
  it('uses the createdDateTime $filter and maps status/appDisplayName', async () => {
    const c = connector();
    const page = await c.fetchAuditPage('signIns', {
      since: '2026-07-01T00:00:00Z',
      until: '2026-07-31T23:59:59Z',
    });
    const req = server.requests.find((r) => r.path.endsWith('/auditLogs/signIns'));
    expect(req?.query['$filter']).toBe(
      'createdDateTime ge 2026-07-01T00:00:00Z and createdDateTime le 2026-07-31T23:59:59Z',
    );

    const rec = page.batches[0]?.records[0];
    expect(rec).toMatchObject({
      system: 'graph_signins',
      providerRecordId: 'si-1',
      operation: 'Office 365 Exchange Online',
      actorEmail: 'avery.chen@example.com',
      actorId: 'u-1',
      actorIp: '203.0.113.44',
      resultStatus: 'success',
      occurredAt: '2026-07-01T08:00:00Z',
    });

    const second = await c.fetchAuditPage('signIns', { cursor: page.nextCursor });
    expect(second.batches[0]?.records[0]?.resultStatus).toBe('Invalid username or password.');
    expect(second.nextCursor).toBeUndefined();
  });
});

describe('GraphAuditConnector sanitized errors', () => {
  it('never leaks the bearer token in error messages', async () => {
    const bad = new GraphAuditConnector({
      tokenProvider: new StaticTokenProvider(TOKEN),
      graphBaseUrl: `${server.url}/graph`,
      sleepImpl: () => Promise.resolve(),
      fetchImpl: () =>
        Promise.resolve(new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })),
    });
    try {
      await bad.fetchAuditPage('directoryAudits', {});
      throw new Error('expected failure');
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});
