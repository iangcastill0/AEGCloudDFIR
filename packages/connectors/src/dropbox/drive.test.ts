import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../http.js';
import { DropboxDriveConnector } from './drive.js';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function stub(responses: (() => Response)[]) {
  const seen: Seen[] = [];
  let i = 0;
  const fetchImpl: FetchLike = (url, init) => {
    // providerFetch normalises init.headers into a Headers instance before it
    // reaches fetch, so reading it as a plain object silently sees nothing.
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    seen.push({ url, headers, body: String(init?.body ?? '') });
    const factory = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (factory === undefined) throw new Error('no queued response');
    return Promise.resolve(factory());
  };
  return { fetchImpl, seen };
}

const json = (payload: unknown) => () =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const tokenProvider = { getAccessToken: () => Promise.resolve('token') };

function connector(fetchImpl: FetchLike, extra: Record<string, unknown> = {}) {
  return new DropboxDriveConnector({
    tokenProvider,
    rpcBase: 'https://rpc.test/2',
    contentBase: 'https://content.test/2',
    fetchImpl,
    ...extra,
  });
}

const PAGE = {
  entries: [
    {
      '.tag': 'file',
      id: 'id:1',
      name: 'a.pdf',
      path_display: '/a.pdf',
      size: 10,
      server_modified: '2026-01-01T00:00:00Z',
      content_hash: 'h',
    },
  ],
  cursor: 'CUR',
  has_more: false,
};

describe('DropboxDriveConnector', () => {
  it('lists from the account root using the empty string, not a slash', async () => {
    // Dropbox rejects '/' for the root. It is the obvious guess, and it fails
    // with a path error that reads like a permissions problem.
    const { fetchImpl, seen } = stub([json(PAGE)]);
    await connector(fetchImpl).listFiles('c');
    expect(seen[0]?.url).toBe('https://rpc.test/2/files/list_folder');
    expect(JSON.parse(seen[0]?.body ?? '{}').path).toBe('');
    expect(JSON.parse(seen[0]?.body ?? '{}').recursive).toBe(true);
  });

  it('continues from a cursor instead of restarting the walk', async () => {
    const { fetchImpl, seen } = stub([json(PAGE)]);
    await connector(fetchImpl).listFiles('c', { cursor: 'CUR' });
    expect(seen[0]?.url).toBe('https://rpc.test/2/files/list_folder/continue');
    expect(JSON.parse(seen[0]?.body ?? '{}').cursor).toBe('CUR');
  });

  it('downloads by id, never by path', async () => {
    // A custodian renaming a file mid-collection would make a path fetch either
    // fail or, worse, return whatever now sits at that path.
    const { fetchImpl, seen } = stub([() => new Response('bytes', { status: 200 })]);
    await connector(fetchImpl).fetchContent('c', {
      providerItemId: 'id:1',
      name: 'a.pdf',
      mimeType: 'application/pdf',
      path: '/a.pdf',
      checksums: {},
      isFolder: false,
      downloadable: true,
    });
    const arg = JSON.parse(seen[0]?.headers['dropbox-api-arg'] ?? '{}');
    expect(arg.path).toBe('id:1');
  });

  it('never claims downloaded bytes are an export derivative', async () => {
    // Dropbox has no native-document export. Marking these as derived would
    // wrongly tell a reviewer they are not the original file.
    const { fetchImpl } = stub([() => new Response('bytes', { status: 200 })]);
    const content = await connector(fetchImpl).fetchContent('c', {
      providerItemId: 'id:1',
      name: 'a.pdf',
      mimeType: 'application/pdf',
      path: '/a.pdf',
      checksums: {},
      isFolder: false,
      downloadable: true,
    });
    expect(content.apiExportDerivative).toBe(false);
  });

  it('omits Select-User entirely in delegated mode', async () => {
    // An empty or wrong Select-User collects someone else's Dropbox. Absent is
    // the only safe default.
    const { fetchImpl, seen } = stub([json(PAGE)]);
    await connector(fetchImpl).listFiles('c');
    expect(seen[0]?.headers['dropbox-api-select-user']).toBeUndefined();
  });

  it('sends Select-User in organization mode', async () => {
    const { fetchImpl, seen } = stub([json(PAGE)]);
    await connector(fetchImpl, { selectUserId: 'dbmid:abc' }).listFiles('c');
    expect(seen[0]?.headers['dropbox-api-select-user']).toBe('dbmid:abc');
  });

  it('treats the cursor as a resume point once the walk is finished', async () => {
    const { fetchImpl } = stub([json(PAGE)]);
    const page = await connector(fetchImpl).listFiles('c');
    expect(page.nextCursor).toBeUndefined();
    expect(page.deltaCursor).toBe('CUR');
  });
});
