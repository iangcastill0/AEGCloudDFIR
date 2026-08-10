import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProviderServer, type FakeProviderServer } from './fake-server.js';
import { GoogleCustodianDirectory } from './google/directory.js';
import { GraphCustodianDirectory } from './microsoft/directory.js';
import { StaticTokenProvider } from './oauth.js';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

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

describe('GraphCustodianDirectory', () => {
  function directory() {
    return new GraphCustodianDirectory({
      tokenProvider: new StaticTokenProvider('fake-token'),
      graphBaseUrl: `${server.url}/graph`,
      sleepImpl: () => Promise.resolve(),
    });
  }

  it('pages through all users and falls back to the UPN for mail-less accounts', async () => {
    const d = directory();
    const page1 = await d.listUsers();
    expect(page1.users.map((u) => u.externalId)).toEqual(['u-1', 'u-2']);
    expect(page1.users[1]?.email).toBe('jordan.lee@example.com');
    expect(page1.nextCursor).toBeDefined();

    const page2 = await d.listUsers({ cursor: page1.nextCursor });
    expect(page2.users.map((u) => u.externalId)).toEqual(['u-3']);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('uses $search with ConsistencyLevel: eventual in search mode', async () => {
    const page = await directory().listUsers({ search: 'avery' });
    expect(page.users).toHaveLength(1);
    expect(page.users[0]?.email).toBe('avery.chen@example.com');
    const req = server.requests.find((r) => r.path === '/graph/users');
    expect(req?.query['$search']).toContain('avery');
    expect(req?.headers['consistencylevel']).toBe('eventual');
  });
});

describe('GoogleCustodianDirectory', () => {
  function directory() {
    return new GoogleCustodianDirectory({
      tokenProvider: new StaticTokenProvider('fake-token'),
      googleApiBaseUrl: `${server.url}/google`,
      sleepImpl: () => Promise.resolve(),
    });
  }

  it('pages through the customer directory', async () => {
    const d = directory();
    const page1 = await d.listUsers();
    expect(page1.users.map((u) => u.externalId)).toEqual(['gu-1', 'gu-2']);
    expect(page1.users[0]?.displayName).toBe('Avery Chen');
    expect(page1.nextCursor).toBe('page2');

    const page2 = await d.listUsers({ cursor: page1.nextCursor });
    expect(page2.users.map((u) => u.externalId)).toEqual(['gu-3']);

    const req = server.requests.find((r) => r.path === '/google/admin/directory/v1/users');
    expect(req?.query['customer']).toBe('my_customer');
  });

  it('passes the search term through the query parameter', async () => {
    const page = await directory().listUsers({ search: 'avery' });
    expect(page.users).toHaveLength(1);
    const req = server.requests.find((r) => r.path === '/google/admin/directory/v1/users');
    expect(req?.query['query']).toBe('avery');
  });
});
