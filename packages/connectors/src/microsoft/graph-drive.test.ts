import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProviderServer, type FakeProviderServer } from '../fake-server.js';
import { StaticTokenProvider } from '../oauth.js';
import { DeltaExpiredError, NonDownloadableError, type DriveContent } from '../types.js';
import { GraphDriveConnector } from './graph-drive.js';

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
  return new GraphDriveConnector({
    tokenProvider: new StaticTokenProvider('fake-token'),
    graphBaseUrl: `${server.url}/graph`,
    mode: 'delegated',
    sleepImpl: () => Promise.resolve(),
  });
}

async function contentBytes(content: DriveContent): Promise<Buffer> {
  if (content.stream instanceof Uint8Array) return Buffer.from(content.stream);
  return Buffer.from(await new Response(content.stream).arrayBuffer());
}

describe('GraphDriveConnector.listDrives', () => {
  it('merges the default drive with the drives collection', async () => {
    const drives = await connector().listDrives('me');
    expect(drives.map((d) => d.id).sort()).toEqual(['d-1', 'd-2']);
  });
});

describe('GraphDriveConnector.listFiles (delta traversal)', () => {
  it('maps hashes, paths, folders, packages and deletions across delta pages', async () => {
    const c = connector();
    const page1 = await c.listFiles('me', { driveId: 'd-1' });

    const folder = page1.items.find((i) => i.providerItemId === 'item-folder1');
    expect(folder?.isFolder).toBe(true);
    expect(folder?.path).toBe('/Reports');
    expect(folder?.downloadable).toBe(false);

    const file = page1.items.find((i) => i.providerItemId === 'item-file1');
    expect(file?.checksums).toEqual({
      quickXorHash: 'QUICKXORHASHBASE64==',
      sha256: 'AB12CD34EF56',
    });
    expect(file?.path).toBe('/Reports/report.docx');
    expect(file?.size).toBe(42);
    expect(file?.driveId).toBe('d-1');
    expect(file?.createdBy).toBe('avery.chen@example.com');
    expect(file?.modifiedBy).toBe('jordan.lee@example.com');
    expect(file?.sharedSummary).toEqual({ scope: 'users' });
    expect(file?.downloadable).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await c.listFiles('me', { cursor: page1.nextCursor });
    const onenote = page2.items.find((i) => i.providerItemId === 'item-onenote1');
    expect(onenote?.downloadable).toBe(false);
    expect(onenote?.isFolder).toBe(false);
    const gone = page2.items.find((i) => i.providerItemId === 'item-gone1');
    expect(gone?.trashed).toBe(true);
    expect(gone?.downloadable).toBe(false);
    expect(page2.deltaCursor).toContain('token=dd-2');
  });

  it('resumes from a delta cursor and returns the next one', async () => {
    const page = await connector().getChangesDelta(
      'me',
      `${server.url}/graph/drives/d-1/root/delta?token=dd-2`,
    );
    expect(page.items).toEqual([]);
    expect(page.deltaCursor).toContain('token=dd-3');
  });

  it('throws DeltaExpiredError on 410', async () => {
    await expect(
      connector().listFiles('me', {
        cursor: `${server.url}/graph/drives/d-1/root/delta?token=expired`,
      }),
    ).rejects.toBeInstanceOf(DeltaExpiredError);
  });
});

describe('GraphDriveConnector.fetchContent', () => {
  it('follows the 302 to the pre-authenticated URL WITHOUT the bearer token', async () => {
    const c = connector();
    const page = await c.listFiles('me', { driveId: 'd-1' });
    const entry = page.items.find((i) => i.providerItemId === 'item-file1');
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const content = await c.fetchContent('me', entry);
    expect(content.apiExportDerivative).toBe(false);
    const expected = readFileSync(join(FIXTURES, 'microsoft/content.item-file1.bin'));
    expect((await contentBytes(content)).equals(expected)).toBe(true);

    const contentReq = server.requests.find((r) => r.path.endsWith('/items/item-file1/content'));
    expect(contentReq?.hadAuthorization).toBe(true);
    const downloadReq = server.requests.find((r) => r.path === '/download/ms/item-file1');
    expect(downloadReq).toBeDefined();
    expect(downloadReq?.hadAuthorization).toBe(false);
  });

  it('raises NonDownloadableError for package items instead of fabricating a native', async () => {
    const c = connector();
    const page1 = await c.listFiles('me', { driveId: 'd-1' });
    const page2 = await c.listFiles('me', { cursor: page1.nextCursor });
    const onenote = page2.items.find((i) => i.providerItemId === 'item-onenote1');
    expect(onenote).toBeDefined();
    if (onenote === undefined) return;
    const err = await c.fetchContent('me', onenote).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonDownloadableError);
    expect((err as NonDownloadableError).kind).toBe('non_downloadable');
    expect((err as NonDownloadableError).providerItemId).toBe('item-onenote1');
  });
});
