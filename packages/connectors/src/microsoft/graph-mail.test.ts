import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProviderServer, type FakeProviderServer } from '../fake-server.js';
import { StaticTokenProvider } from '../oauth.js';
import { DeltaExpiredError, type RateLimitObserver } from '../types.js';
import { GraphEmailConnector } from './graph-mail.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));

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

function connector(
  mode: 'delegated' | 'organization' = 'delegated',
  onRateLimit?: RateLimitObserver,
) {
  return new GraphEmailConnector({
    tokenProvider: new StaticTokenProvider('fake-token'),
    graphBaseUrl: `${server.url}/graph`,
    mode,
    onRateLimit,
    sleepImpl: () => Promise.resolve(),
  });
}

describe('GraphEmailConnector.listMailFolders', () => {
  it('recurses child folders, follows pagination and builds materialized paths', async () => {
    const { folders, exceptions } = await connector().listMailFolders('me');
    const paths = folders.map((f) => f.path);
    expect(paths).toEqual([
      '/Inbox',
      '/Inbox/Projects',
      '/Deleted Items',
      '/Archive',
      '/Deletions',
    ]);
    const recoverable = folders.find((f) => f.wellKnown === 'recoverableitemsdeletions');
    expect(recoverable?.id).toBe('f-recoverable');
    const projects = folders.find((f) => f.id === 'f-projects');
    expect(projects?.parentId).toBe('f-inbox');
    expect(exceptions).toEqual([]);
  });

  it('records a permission exception instead of failing when recoverable items are denied', async () => {
    const { folders, exceptions } = await connector('organization').listMailFolders(
      'no-recoverable@example.com',
    );
    expect(folders.length).toBeGreaterThan(0);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.kind).toBe('permission_denied');
  });
});

describe('GraphEmailConnector.listMessages', () => {
  it('pages via @odata.nextLink cursors and sends the ImmutableId Prefer header', async () => {
    const c = connector();
    const page1 = await c.listMessages('me', 'f-inbox');
    expect(page1.items.map((i) => i.providerItemId)).toEqual(['m-001']);
    expect(page1.items[0]?.providerImmutableId).toBe('m-001');
    expect(page1.items[0]?.folderId).toBe('f-inbox');
    expect(page1.nextCursor).toBeDefined();

    const page2 = await c.listMessages('me', 'f-inbox', { cursor: page1.nextCursor });
    expect(page2.items.map((i) => i.providerItemId)).toEqual(['m-002']);
    expect(page2.nextCursor).toBeUndefined();

    const listRequests = server.requests.filter((r) =>
      r.path.endsWith('/mailFolders/f-inbox/messages'),
    );
    expect(listRequests).toHaveLength(2);
    for (const r of listRequests) {
      expect(r.headers['prefer']).toContain('IdType="ImmutableId"');
    }
  });

  it('applies receivedDateTime range filters', async () => {
    await connector().listMessages('me', 'f-inbox', {
      since: '2024-01-01T00:00:00Z',
      until: '2024-06-30T23:59:59Z',
    });
    const req = server.requests.find((r) => r.path.endsWith('/messages'));
    expect(req?.query['$filter']).toBe(
      'receivedDateTime ge 2024-01-01T00:00:00Z and receivedDateTime le 2024-06-30T23:59:59Z',
    );
  });

  it('recovers from a single 429 with Retry-After and surfaces the wait', async () => {
    const waits: { reason: string; waitMs: number }[] = [];
    const c = connector('delegated', (info) => waits.push(info));
    const page = await c.listMessages('me', 'f-inbox', {
      cursor: `${server.url}/graph/me/mailFolders/f-inbox/messages?flaky=1`,
    });
    expect(page.items).toHaveLength(1);
    expect(waits).toEqual([expect.objectContaining({ reason: 'retry-after', waitMs: 1000 })]);
  });
});

describe('GraphEmailConnector.fetchMessage', () => {
  it('returns the exact RFC822 native and full API metadata including BCC when present', async () => {
    const fetched = await connector().fetchMessage('me', 'm-001');
    const expected = readFileSync(join(FIXTURES, 'microsoft/message.m-001.eml'));
    expect(Buffer.from(fetched.rfc822).equals(expected)).toBe(true);

    const md = fetched.metadata;
    expect(md.subject).toBe('Q3 vendor contract - revised terms');
    expect(md.from?.address).toBe('avery.chen@example.com');
    expect(md.toRecipients?.[0]?.address).toBe('jordan.lee@example.com');
    expect(md.ccRecipients?.[0]?.address).toBe('sam.rivera@example.com');
    expect(md.bccRecipients).toHaveLength(1);
    expect(md.bccRecipients?.[0]?.address).toBe('quinn.park@example.com');
    expect(md.internetMessageHeaders).toHaveLength(2);
    expect(md.conversationId).toBe('conv-1');
    expect(md.folderId).toBe('f-inbox');
    expect(md.categories).toEqual(['Litigation Hold']);
    expect(md.bodyContentType).toBe('html');
    const inline = md.attachments?.find((a) => a.isInline === true);
    expect(inline?.contentId).toBe('logo-cid@example.com');
  });

  it('omits bccRecipients when the API returned none', async () => {
    const fetched = await connector().fetchMessage('me', 'm-002');
    expect(fetched.metadata.bccRecipients).toBeUndefined();
  });

  it('duplicate delivery safety: fetching twice yields identical bytes', async () => {
    const c = connector();
    const a = await c.fetchMessage('me', 'm-001');
    const b = await c.fetchMessage('me', 'm-001');
    expect(Buffer.from(a.rfc822).equals(Buffer.from(b.rfc822))).toBe(true);
  });

  it('works identically through the organization-mode /users segment', async () => {
    const fetched = await connector('organization').fetchMessage('custodian@example.com', 'm-001');
    const expected = readFileSync(join(FIXTURES, 'microsoft/message.m-001.eml'));
    expect(Buffer.from(fetched.rfc822).equals(expected)).toBe(true);
    const req = server.requests.find((r) => r.path.includes('/users/custodian@example.com/'));
    expect(req).toBeDefined();
  });
});

describe('GraphEmailConnector.getMailDelta', () => {
  it('walks nextLink pages, flags removed items and returns the delta cursor', async () => {
    const c = connector();
    const page1 = await c.getMailDelta('me', 'f-inbox');
    expect(page1.items.map((i) => i.providerItemId)).toEqual(['m-001']);
    expect(page1.nextCursor).toBeDefined();
    expect(page1.deltaCursor).toBeUndefined();

    const page2 = await c.getMailDelta('me', 'f-inbox', page1.nextCursor);
    expect(page2.items[0]?.providerItemId).toBe('m-004');
    expect(page2.items[0]?.deleted).toBe(true);
    expect(page2.deltaCursor).toContain('token=delta-2');
  });

  it('resumes from a stored deltaLink and returns a fresh cursor', async () => {
    const c = connector();
    const resumed = await c.getMailDelta(
      'me',
      'f-inbox',
      `${server.url}/graph/me/mailFolders/f-inbox/messages/delta?token=delta-2`,
    );
    expect(resumed.items).toEqual([]);
    expect(resumed.deltaCursor).toContain('token=delta-3');
  });

  it('throws DeltaExpiredError on 410 Gone', async () => {
    await expect(
      connector().getMailDelta(
        'me',
        'f-inbox',
        `${server.url}/graph/me/mailFolders/f-inbox/messages/delta?token=expired`,
      ),
    ).rejects.toBeInstanceOf(DeltaExpiredError);
  });
});
