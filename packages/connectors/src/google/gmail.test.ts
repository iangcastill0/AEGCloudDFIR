import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProviderServer, type FakeProviderServer } from '../fake-server.js';
import { StaticTokenProvider } from '../oauth.js';
import { HistoryExpiredError, ProviderApiError } from '../types.js';
import { GMAIL_ACCOUNT_FOLDER, GmailConnector, gmailDate } from './gmail.js';

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

function connector() {
  return new GmailConnector({
    tokenProvider: new StaticTokenProvider('fake-token'),
    googleApiBaseUrl: `${server.url}/google`,
    sleepImpl: () => Promise.resolve(),
  });
}

describe('gmailDate', () => {
  it('formats ISO timestamps as Gmail YYYY/MM/DD (UTC)', () => {
    expect(gmailDate('2024-01-01T00:00:00Z')).toBe('2024/01/01');
    expect(gmailDate('2024-06-30T23:59:59Z')).toBe('2024/06/30');
  });
});

describe('GmailConnector.listMailFolders', () => {
  it('maps labels to folders and marks system labels as well-known', async () => {
    const { folders, exceptions } = await connector().listMailFolders('me');
    expect(folders.map((f) => f.id)).toEqual(['INBOX', 'SPAM', 'TRASH', 'Label_7']);
    expect(folders.find((f) => f.id === 'INBOX')?.wellKnown).toBe('INBOX');
    expect(folders.find((f) => f.id === 'Label_7')?.wellKnown).toBeUndefined();
    expect(folders.find((f) => f.id === 'Label_7')?.path).toBe('/Cases/Acme');
    expect(exceptions).toEqual([]);
  });
});

describe('GmailConnector.listMessages', () => {
  it('builds the q date range and pages with pageToken', async () => {
    const c = connector();
    const page1 = await c.listMessages('me', 'INBOX', {
      since: '2024-01-01T00:00:00Z',
      until: '2024-06-30T23:59:59Z',
    });
    expect(page1.items.map((i) => i.providerItemId)).toEqual(['g-001']);
    expect(page1.nextCursor).toBe('page2');

    const page2 = await c.listMessages('me', 'INBOX', { cursor: page1.nextCursor });
    expect(page2.items.map((i) => i.providerItemId)).toEqual(['g-002']);
    expect(page2.nextCursor).toBeUndefined();

    const req = server.requests.find((r) => r.path.endsWith('/messages'));
    expect(req?.query['q']).toBe('after:2024/01/01 before:2024/06/30');
    expect(req?.query['labelIds']).toBe('INBOX');
    expect(req?.query['includeSpamTrash']).toBeUndefined();
  });

  it('sets includeSpamTrash only when deleted content is selected', async () => {
    await connector().listMessages('me', 'SPAM', { includeDeleted: true });
    const req = server.requests.find((r) => r.path.endsWith('/messages'));
    expect(req?.query['includeSpamTrash']).toBe('true');
  });
});

describe('GmailConnector.fetchMessage', () => {
  it('decodes format=raw base64url into the exact RFC822 bytes and keeps API metadata', async () => {
    const fetched = await connector().fetchMessage('me', 'g-001');
    const expected = readFileSync(join(FIXTURES, 'google/message.g-001.eml'));
    expect(Buffer.from(fetched.rfc822).equals(expected)).toBe(true);
    expect(fetched.metadata.threadId).toBe('t-1');
    expect(fetched.metadata.labelIds).toEqual(['INBOX', 'IMPORTANT']);
    expect(fetched.metadata.historyId).toBe('h100');
    expect(fetched.metadata.receivedAt).toBe(new Date(1709633700000).toISOString());
  });

  it('duplicate delivery safety: fetching twice yields identical bytes', async () => {
    const c = connector();
    const a = await c.fetchMessage('me', 'g-002');
    const b = await c.fetchMessage('me', 'g-002');
    expect(Buffer.from(a.rfc822).equals(Buffer.from(b.rfc822))).toBe(true);
  });
});

describe('GmailConnector.getMailDelta', () => {
  it('aggregates additions and deletions across history pages and advances the cursor', async () => {
    const page = await connector().getMailDelta('me', GMAIL_ACCOUNT_FOLDER, 'h100');
    const added = page.items.find((i) => i.providerItemId === 'g-003');
    expect(added?.deleted).toBeUndefined();
    expect(added?.labelIds).toEqual(['INBOX']);
    const deleted = page.items.find((i) => i.providerItemId === 'g-001');
    expect(deleted?.deleted).toBe(true);
    expect(page.deltaCursor).toBe('h300');

    const historyRequests = server.requests.filter((r) => r.path.endsWith('/history'));
    expect(historyRequests).toHaveLength(2);
    expect(historyRequests.every((r) => r.query['startHistoryId'] === 'h100')).toBe(true);
  });

  it('throws HistoryExpiredError when the checkpoint returns 404', async () => {
    await expect(
      connector().getMailDelta('me', GMAIL_ACCOUNT_FOLDER, 'expired'),
    ).rejects.toBeInstanceOf(HistoryExpiredError);
  });

  it('refuses to run without a starting historyId', async () => {
    await expect(
      connector().getMailDelta('me', GMAIL_ACCOUNT_FOLDER),
    ).rejects.toBeInstanceOf(ProviderApiError);
  });
});
