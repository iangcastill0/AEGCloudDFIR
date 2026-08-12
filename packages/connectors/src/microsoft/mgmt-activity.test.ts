import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProviderServer, type FakeProviderServer } from '../fake-server.js';
import { StaticTokenProvider } from '../oauth.js';
import type { FetchLike } from '../http.js';
import type { RateLimitObserver } from '../types.js';
import { O365ManagementActivityConnector } from './mgmt-activity.js';

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

function connector(opts: { onRateLimit?: RateLimitObserver; fetchImpl?: FetchLike } = {}) {
  return new O365ManagementActivityConnector({
    tokenProvider: new StaticTokenProvider(TOKEN),
    tenantId: 'tenant-1',
    managementBaseUrl: `${server.url}/manage`,
    contentTypes: ['Audit.Exchange'],
    onRateLimit: opts.onRateLimit,
    fetchImpl: opts.fetchImpl,
    sleepImpl: () => Promise.resolve(),
  });
}

describe('O365ManagementActivityConnector.listAuditScopes', () => {
  it('returns the configured content types as scopes', async () => {
    const scopes = await connector().listAuditScopes();
    expect(scopes).toEqual([{ scopeKey: 'Audit.Exchange', label: 'Audit.Exchange' }]);
  });
});

describe('O365ManagementActivityConnector.ensureSubscriptions', () => {
  it('starts each subscription (200 OK) against the constructor base URL', async () => {
    await connector().ensureSubscriptions();
    const starts = server.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/subscriptions/start'),
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]?.query['contentType']).toBe('Audit.Exchange');
  });

  it('treats an already-enabled 400/AF20024 as success', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'AF20024', message: 'subscription already enabled' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    await expect(connector({ fetchImpl }).ensureSubscriptions()).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('throws a sanitized error for a non-idempotent failure without leaking the token', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'AF20055', message: 'bad tenant' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );
    await expect(connector({ fetchImpl }).ensureSubscriptions()).rejects.toThrow(
      /ensureSubscriptions/,
    );
    try {
      await connector({ fetchImpl }).ensureSubscriptions();
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});

describe('O365ManagementActivityConnector.fetchAuditPage', () => {
  it('reads the content list, downloads the blob and maps UAL records', async () => {
    const page = await connector().fetchAuditPage('Audit.Exchange', {});
    expect(page.batches).toHaveLength(1);
    const batch = page.batches[0];
    expect(batch?.system).toBe('o365_management_activity');
    expect(batch?.batchId).toBe('blob1');
    expect(batch?.scopeKey).toBe('Audit.Exchange');
    expect(batch?.providerReportedCount).toBe(2);

    // rawBytes preserves the untouched blob JSON.
    const rawParsed = JSON.parse(new TextDecoder().decode(batch?.rawBytes)) as unknown[];
    expect(rawParsed).toHaveLength(2);

    const [exch, aad] = batch?.records ?? [];
    expect(exch).toMatchObject({
      providerRecordId: 'ual-exch-1',
      operation: 'MailItemsAccessed',
      workload: 'Exchange',
      recordType: '2',
      actorEmail: 'avery.chen@example.com',
      actorId: 'avery.chen@example.com',
      actorIp: '203.0.113.11',
      resultStatus: 'Succeeded',
      occurredAt: '2026-07-01T09:15:00',
    });
    // ActorIpAddress is used when ClientIP is absent.
    expect(aad?.actorIp).toBe('203.0.113.23');
    expect(aad?.workload).toBe('AzureActiveDirectory');

    // The blob was fetched from the contentUri advertised by the content list.
    const blobReq = server.requests.find((r) => r.path === '/manage/content/blob1');
    expect(blobReq).toBeDefined();
  });

  it('resumes paging via the NextPageUri cursor', async () => {
    const c = connector();
    const first = await c.fetchAuditPage('Audit.Exchange', {});
    expect(first.batches).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();

    const second = await c.fetchAuditPage('Audit.Exchange', { cursor: first.nextCursor });
    expect(second.batches).toEqual([]);
    expect(second.nextCursor).toBeUndefined();

    // Page 2 was reached by following the NextPageUri (page=2), not a fresh window.
    const contentReqs = server.requests.filter((r) => r.path.endsWith('/subscriptions/content'));
    expect(contentReqs.some((r) => r.query['page'] === '2')).toBe(true);
  });

  it('chunks a >24h window into <=24h subranges advertised through the cursor', async () => {
    const c = connector();
    const since = '2026-07-01T00:00:00Z';
    const until = '2026-07-04T00:00:00Z'; // 3 days -> 3 subranges

    let cursor: string | undefined;
    let guard = 0;
    do {
      const page = await c.fetchAuditPage('Audit.Exchange', { since, until, cursor });
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== undefined && guard < 20);
    expect(guard).toBeLessThan(20);

    const windows = server.requests
      .filter((r) => r.path.endsWith('/subscriptions/content') && r.query['startTime'] !== undefined)
      .map((r) => ({ start: r.query['startTime'] as string, end: r.query['endTime'] as string }));

    expect(windows).toHaveLength(3);
    const DAY = 24 * 60 * 60 * 1000;
    // Management times are UTC without an offset suffix; parse them as UTC.
    const asUtc = (t: string): number => Date.parse(`${t}Z`);
    for (const w of windows) {
      expect(asUtc(w.end) - asUtc(w.start)).toBeLessThanOrEqual(DAY);
    }
    // Contiguous, tiling [since, until].
    expect(asUtc(windows[0]?.start ?? '')).toBe(Date.parse(since));
    expect(asUtc(windows[2]?.end ?? '')).toBe(Date.parse(until));
    expect(windows[0]?.end).toBe(windows[1]?.start);
    expect(windows[1]?.end).toBe(windows[2]?.start);
  });

  it('rejects a window with only one bound', async () => {
    await expect(
      connector().fetchAuditPage('Audit.Exchange', { since: '2026-07-01T00:00:00Z' }),
    ).rejects.toThrow(/both since and until/);
  });

  it('honors a 429 Retry-After and surfaces the wait', async () => {
    const waits: { reason: string; waitMs: number }[] = [];
    let hits = 0;
    const fetchImpl: FetchLike = (url, init) => {
      hits += 1;
      if (hits === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'TooManyRequests' } }), {
            status: 429,
            headers: { 'retry-after': '1', 'content-type': 'application/json' },
          }),
        );
      }
      return fetch(url, init);
    };
    const page = await connector({ fetchImpl, onRateLimit: (info) => waits.push(info) }).fetchAuditPage(
      'Audit.Exchange',
      {},
    );
    expect(page.batches).toHaveLength(1);
    expect(waits).toEqual([expect.objectContaining({ reason: 'retry-after', waitMs: 1000 })]);
  });
});
