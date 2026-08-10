import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProviderServer, type FakeProviderServer } from '../fake-server.js';
import { StaticTokenProvider } from '../oauth.js';
import { NonDownloadableError, type DriveContent, type DriveEntry } from '../types.js';
import { GoogleDriveConnector } from './drive.js';

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
  return new GoogleDriveConnector({
    tokenProvider: new StaticTokenProvider('fake-token'),
    googleApiBaseUrl: `${server.url}/google`,
    sleepImpl: () => Promise.resolve(),
  });
}

async function contentBytes(content: DriveContent): Promise<Buffer> {
  if (content.stream instanceof Uint8Array) return Buffer.from(content.stream);
  return Buffer.from(await new Response(content.stream).arrayBuffer());
}

function googleDocEntry(overrides: Partial<DriveEntry> = {}): DriveEntry {
  return {
    providerItemId: 'gd-doc1',
    name: 'Case Summary',
    mimeType: 'application/vnd.google-apps.document',
    path: '/Cases/Case Summary',
    checksums: {},
    isFolder: false,
    downloadable: true,
    googleNativeType: 'application/vnd.google-apps.document',
    ...overrides,
  };
}

describe('GoogleDriveConnector.listDrives', () => {
  it('enumerates shared drives', async () => {
    const drives = await connector().listDrives('me');
    expect(drives).toEqual([{ id: 'sd-1', name: 'Legal Shared Drive', driveType: 'shared' }]);
  });
});

describe('GoogleDriveConnector.listFiles', () => {
  it('requests exact fields, maps checksums and reconstructs paths with memoization', async () => {
    const c = connector();
    const page1 = await c.listFiles('me');

    const listReq = server.requests.find((r) => r.path === '/google/drive/v3/files');
    expect(listReq?.query['fields']).toContain('sha256Checksum');
    expect(listReq?.query['fields']).toContain('md5Checksum');
    expect(listReq?.query['supportsAllDrives']).toBe('true');
    expect(listReq?.query['q']).toBe('trashed = false');

    const folder = page1.items.find((i) => i.providerItemId === 'gd-folder1');
    expect(folder?.isFolder).toBe(true);
    expect(folder?.path).toBe('/Cases');
    expect(folder?.downloadable).toBe(false);

    const file = page1.items.find((i) => i.providerItemId === 'gd-file1');
    expect(file?.checksums).toEqual({
      md5: '9e107d9d372bb6826bd81d3542a419d6',
      sha256: 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    });
    expect(file?.path).toBe('/Cases/evidence.txt');
    expect(file?.size).toBe(44);
    expect(file?.versionId).toBe('7');
    expect(file?.googleNativeType).toBeUndefined();

    const page2 = await c.listFiles('me', { cursor: page1.nextCursor });
    const doc = page2.items.find((i) => i.providerItemId === 'gd-doc1');
    expect(doc?.googleNativeType).toBe('application/vnd.google-apps.document');
    expect(doc?.downloadable).toBe(true);
    expect(doc?.path).toBe('/Cases/Case Summary');

    // Path memoization: each unique parent resolved via files.get exactly once.
    const folderLookups = server.requests.filter(
      (r) => r.path === '/google/drive/v3/files/gd-folder1',
    );
    const rootLookups = server.requests.filter(
      (r) => r.path === '/google/drive/v3/files/gd-root',
    );
    expect(folderLookups).toHaveLength(1);
    expect(rootLookups).toHaveLength(1);
  });

  it('widens the trashed clause when trashed content is selected', async () => {
    await connector().listFiles('me', { includeTrashed: true });
    const req = server.requests.find((r) => r.path === '/google/drive/v3/files');
    expect(req?.query['q']).toBe('(trashed = true or trashed = false)');
  });
});

describe('GoogleDriveConnector.fetchContent', () => {
  it('downloads binaries via alt=media', async () => {
    const c = connector();
    const page = await c.listFiles('me');
    const entry = page.items.find((i) => i.providerItemId === 'gd-file1');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const content = await c.fetchContent('me', entry);
    expect(content.apiExportDerivative).toBe(false);
    const expected = readFileSync(join(FIXTURES, 'google/content.gd-file1.bin'));
    expect((await contentBytes(content)).equals(expected)).toBe(true);
    const req = server.requests.find(
      (r) => r.path === '/google/drive/v3/files/gd-file1' && r.query['alt'] === 'media',
    );
    expect(req).toBeDefined();
  });

  it('exports Google-native docs as pdf by default, flagged apiExportDerivative', async () => {
    const content = await connector().fetchContent('me', googleDocEntry());
    expect(content.apiExportDerivative).toBe(true);
    expect(content.exportFormat).toBe('pdf');
    expect(content.sourceNativeMimeType).toBe('application/vnd.google-apps.document');
    const expected = readFileSync(join(FIXTURES, 'google/export.gd-doc1.pdf.bin'));
    expect((await contentBytes(content)).equals(expected)).toBe(true);
  });

  it('supports the configured docx export target', async () => {
    const content = await connector().fetchContent('me', googleDocEntry(), {
      exportMimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(content.apiExportDerivative).toBe(true);
    expect(content.exportFormat).toBe('docx');
    const expected = readFileSync(join(FIXTURES, 'google/export.gd-doc1.docx.bin'));
    expect((await contentBytes(content)).equals(expected)).toBe(true);
  });

  it('rejects unmapped Google-native types as unsupported items', async () => {
    const err = await connector()
      .fetchContent(
        'me',
        googleDocEntry({
          providerItemId: 'gd-jam1',
          mimeType: 'application/vnd.google-apps.jam',
          googleNativeType: 'application/vnd.google-apps.jam',
          downloadable: false,
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonDownloadableError);
    expect((err as NonDownloadableError).kind).toBe('unsupported_item');
  });

  it('maps exportSizeLimitExceeded to NonDownloadableError', async () => {
    const err = await connector()
      .fetchContent('me', googleDocEntry({ providerItemId: 'gd-huge' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonDownloadableError);
    expect((err as NonDownloadableError).message).toContain('exportSizeLimitExceeded');
  });
});

describe('GoogleDriveConnector.getChangesDelta', () => {
  it('bootstraps from startPageToken and advances to newStartPageToken', async () => {
    const page = await connector().getChangesDelta('me');
    expect(page.deltaCursor).toBe('sp-2');
    expect(page.nextCursor).toBeUndefined();

    const updated = page.items.find((i) => i.providerItemId === 'gd-file1');
    expect(updated?.versionId).toBe('8');
    expect(updated?.path).toBe('/Cases/evidence.txt');

    const removed = page.items.find((i) => i.providerItemId === 'gd-removed1');
    expect(removed?.trashed).toBe(true);
    expect(removed?.downloadable).toBe(false);

    const startReq = server.requests.find(
      (r) => r.path === '/google/drive/v3/changes/startPageToken',
    );
    expect(startReq).toBeDefined();
  });
});
