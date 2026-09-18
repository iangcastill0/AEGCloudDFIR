import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProviderServer, type FakeProviderServer } from '../fake-server.js';
import { StaticTokenProvider } from '../oauth.js';
import { GoogleReportsConnector } from './reports.js';

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

function connector() {
  return new GoogleReportsConnector({
    tokenProvider: new StaticTokenProvider(TOKEN),
    googleApiBaseUrl: `${server.url}/google`,
    applications: ['login', 'drive'],
    sleepImpl: () => Promise.resolve(),
  });
}

describe('GoogleReportsConnector.listAuditScopes', () => {
  it('returns the configured applications', async () => {
    expect(await connector().listAuditScopes()).toEqual([
      { scopeKey: 'login', label: 'login' },
      { scopeKey: 'drive', label: 'drive' },
    ]);
  });
});

describe('GoogleReportsConnector.fetchAuditPage', () => {
  it('flattens item/events into records and maps occurredAt', async () => {
    const page = await connector().fetchAuditPage('login', {});
    expect(page.batches).toHaveLength(1);
    const batch = page.batches[0];
    expect(batch?.system).toBe('google_reports');
    expect(batch?.records).toHaveLength(1);
    expect(batch?.records[0]).toMatchObject({
      providerRecordId: '-1234567890123456789:2026-07-01T12:00:00.000Z',
      operation: 'login_success',
      recordType: 'login',
      workload: 'login',
      actorEmail: 'avery.chen@example.com',
      actorId: '1122334455',
      actorIp: '203.0.113.7',
      occurredAt: '2026-07-01T12:00:00.000Z',
    });
    // raw carries the untouched event (name + parameters).
    const raw = batch?.records[0]?.raw as { name?: string; parameters?: unknown[] };
    expect(raw.name).toBe('login_success');
    expect(raw.parameters).toBeDefined();
    expect(page.nextCursor).toBe('page2');
  });

  it('pages via pageToken', async () => {
    const c = connector();
    const first = await c.fetchAuditPage('login', {});
    const second = await c.fetchAuditPage('login', { cursor: first.nextCursor });
    expect(second.batches[0]?.records[0]?.operation).toBe('logout');
    expect(second.nextCursor).toBeUndefined();

    const req = server.requests.find(
      (r) => r.path.includes('/applications/login') && r.query['pageToken'] === 'page2',
    );
    expect(req).toBeDefined();
  });

  it('uses a single actor as the userKey, otherwise "all"', async () => {
    const c = connector();
    await c.fetchAuditPage('login', { actorFilter: ['avery.chen@example.com'] });
    expect(
      server.requests.some((r) =>
        r.path.includes('/users/avery.chen@example.com/applications/login'),
      ),
    ).toBe(true);

    server.reset();
    await c.fetchAuditPage('login', { actorFilter: ['a@example.com', 'b@example.com'] });
    expect(server.requests.some((r) => r.path.includes('/users/all/applications/login'))).toBe(
      true,
    );

    server.reset();
    await c.fetchAuditPage('login', {});
    expect(server.requests.some((r) => r.path.includes('/users/all/applications/login'))).toBe(
      true,
    );
  });

  it('sends startTime/endTime bounds when provided', async () => {
    await connector().fetchAuditPage('drive', {
      since: '2026-07-01T00:00:00.000Z',
      until: '2026-07-02T00:00:00.000Z',
    });
    const req = server.requests.find((r) => r.path.includes('/applications/drive'));
    expect(req?.query['startTime']).toBe('2026-07-01T00:00:00.000Z');
    expect(req?.query['endTime']).toBe('2026-07-02T00:00:00.000Z');
  });

  it('decodes gmail event_info.mail_event_type into a readable operation and message id', async () => {
    const c = new GoogleReportsConnector({
      tokenProvider: new StaticTokenProvider(TOKEN),
      googleApiBaseUrl: `${server.url}/google`,
      applications: ['gmail'],
      sleepImpl: () => Promise.resolve(),
    });
    const page = await c.fetchAuditPage('gmail', {
      since: '2026-07-01T00:00:00.000Z',
      until: '2026-07-08T00:00:00.000Z',
    });
    const records = page.batches[0]?.records ?? [];
    expect(records).toHaveLength(2);
    // 31 = "Message viewed" — the forensic event we care about.
    expect(records[0]).toMatchObject({
      operation: 'Message viewed',
      recordType: 'gmail_mail_event:31',
      workload: 'gmail',
      actorEmail: 'avery.chen@example.com',
      targetId: '<q3-contract@mail.example.com>',
    });
    // 7 = "Message opened (first time)".
    expect(records[1]).toMatchObject({
      operation: 'Message opened (first time)',
      recordType: 'gmail_mail_event:7',
    });
  });

  it('rejects a gmail query without a bounded window', async () => {
    const c = new GoogleReportsConnector({
      tokenProvider: new StaticTokenProvider(TOKEN),
      googleApiBaseUrl: `${server.url}/google`,
      applications: ['gmail'],
      sleepImpl: () => Promise.resolve(),
    });
    await expect(c.fetchAuditPage('gmail', {})).rejects.toThrow(/require both since and until/);
    await expect(
      c.fetchAuditPage('gmail', {
        since: '2026-01-01T00:00:00.000Z',
        until: '2026-07-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/30-day window/);
  });

  it('never leaks the bearer token in error messages', async () => {
    const bad = new GoogleReportsConnector({
      tokenProvider: new StaticTokenProvider(TOKEN),
      googleApiBaseUrl: `${server.url}/google`,
      applications: ['login'],
      sleepImpl: () => Promise.resolve(),
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 500 })),
    });
    try {
      await bad.fetchAuditPage('login', {});
      throw new Error('expected failure');
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});
