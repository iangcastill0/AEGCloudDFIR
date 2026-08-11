/**
 * Local fake provider server — FOR TESTS AND THE CLEARLY-LABELED DEMO MODE
 * ONLY. Never deploy against production data.
 *
 * Speaks just enough Graph-shaped and Gmail/Drive-shaped JSON to run the
 * connectors end-to-end from sanitized fixture files. See
 * src/fixtures/README.md for the fixture directory layout. Exported from the
 * separate entrypoint '@evidencevault/connectors/fake'.
 *
 * Conventions:
 * - '{{BASE}}' inside JSON fixtures is replaced with the server's base URL,
 *   so fixtures can carry @odata.nextLink / deltaLink values.
 * - '?page=N' selects '<name>.pageN.json'; '?token=T' selects
 *   '<name>.token-T.json' (Graph delta resume). token=expired → HTTP 410.
 * - Gmail/Drive style paging uses pageToken values that name the page file
 *   suffix ('page2' → '<name>.page2.json'; absent → page1).
 * - '?flaky=1' on any GET returns a single 429 with Retry-After: 1 for the
 *   first hit of that URL, then succeeds.
 * - Gmail format=raw responses are assembled from '<id>.eml' on the fly
 *   (base64url), keeping fixtures readable.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  hadAuthorization: boolean;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeProviderServer {
  url: string;
  /** Every request the server saw, for assertions (auth headers, Prefer, queries). */
  requests: RecordedRequest[];
  close(): Promise<void>;
  reset(): void;
}

const GMAIL_RE = /^\/google\/gmail\/v1\/users\/[^/]+/;

export async function startFakeProviderServer(
  fixtureDir: string,
  port = 0,
): Promise<FakeProviderServer> {
  const requests: RecordedRequest[] = [];
  const flaked = new Set<string>();
  let baseUrl = '';

  const readFixture = async (relative: string): Promise<Buffer | undefined> => {
    try {
      return await readFile(join(fixtureDir, relative));
    } catch {
      return undefined;
    }
  };

  const sendJsonFile = async (
    res: ServerResponse,
    relative: string,
    /** Listing routes: a missing fixture means an empty collection, not 404. */
    emptyOnMissing = false,
  ): Promise<void> => {
    const buf = await readFixture(relative);
    if (buf === undefined) {
      if (emptyOnMissing) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ value: [] }));
        return;
      }
      sendError(res, 404, 'itemNotFound', `no fixture ${relative}`);
      return;
    }
    const body = buf.toString('utf8').replaceAll('{{BASE}}', baseUrl);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  };

  const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  const sendError = (res: ServerResponse, status: number, code: string, message: string): void => {
    sendJson(res, status, { error: { code, message } });
  };

  const sendBinary = async (
    res: ServerResponse,
    relative: string,
    contentType: string,
  ): Promise<void> => {
    const buf = await readFixture(relative);
    if (buf === undefined) {
      sendError(res, 404, 'itemNotFound', `no fixture ${relative}`);
      return;
    }
    res.writeHead(200, { 'content-type': contentType });
    res.end(buf);
  };

  /** page/token file suffix for Graph-style routes. */
  const graphSuffix = (query: URLSearchParams): string => {
    const token = query.get('token');
    if (token !== null) return `token-${token}`;
    return `page${query.get('page') ?? '1'}`;
  };

  /** pageToken file suffix for Google-style routes. */
  const googleSuffix = (query: URLSearchParams): string => query.get('pageToken') ?? 'page1';

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', baseUrl);
    const path = decodeURIComponent(url.pathname);
    const q = url.searchParams;
    const method = req.method ?? 'GET';

    let body = '';
    for await (const chunk of req) {
      body += String(chunk);
    }

    const headerRecord: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headerRecord[name.toLowerCase()] = value;
    }
    requests.push({
      method,
      path,
      query: Object.fromEntries(q.entries()),
      hadAuthorization: req.headers.authorization !== undefined,
      headers: headerRecord,
      body: body === '' ? undefined : body,
    });

    // One-shot throttling mode for retry tests.
    if (q.get('flaky') === '1') {
      const key = `${method} ${path}?${q.toString()}`;
      if (!flaked.has(key)) {
        flaked.add(key);
        res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'TooManyRequests', message: 'throttled' } }));
        return;
      }
    }

    // ---- Token endpoints (canned) ----
    if (method === 'POST' && /^\/[^/]+\/oauth2\/v2\.0\/token$/.test(path)) {
      await sendJsonFile(res, 'microsoft/token.json');
      return;
    }
    if (method === 'POST' && path === '/token') {
      await sendJsonFile(res, 'google/token.json');
      return;
    }

    if (method !== 'GET') {
      sendError(res, 405, 'methodNotAllowed', 'only GET is supported here');
      return;
    }

    // ---- Pre-authenticated download host (no Authorization expected) ----
    let m = /^\/download\/ms\/([^/]+)$/.exec(path);
    if (m !== null) {
      await sendBinary(res, `microsoft/content.${m[1]}.bin`, 'application/octet-stream');
      return;
    }

    // ---- Microsoft Graph shaped ----
    if (path.startsWith('/graph/')) {
      const g = path.slice('/graph'.length);
      // normalize /me and /users/{id} to the same fixture space
      const seg = g.replace(/^\/users\/[^/]+/, '/me');
      const isNoRecoverableCustodian = /^\/users\/no-recoverable@/.test(g);

      if (seg === '/me/mailFolders') {
        await sendJsonFile(res, `microsoft/mailFolders.${graphSuffix(q)}.json`);
        return;
      }
      if (seg === '/me/mailFolders/recoverableitemsdeletions') {
        if (isNoRecoverableCustodian) {
          sendError(res, 403, 'ErrorAccessDenied', 'access to recoverable items is denied');
          return;
        }
        await sendJsonFile(res, 'microsoft/recoverableitemsdeletions.json');
        return;
      }
      m = /^\/me\/mailFolders\/([^/]+)\/childFolders$/.exec(seg);
      if (m !== null) {
        const file = `microsoft/childFolders.${m[1]}.json`;
        if ((await readFixture(file)) === undefined) {
          sendJson(res, 200, { value: [] });
        } else {
          await sendJsonFile(res, file);
        }
        return;
      }
      m = /^\/me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(seg);
      if (m !== null) {
        if (q.get('token') === 'expired') {
          sendError(res, 410, 'resyncRequired', 'delta token expired');
          return;
        }
        await sendJsonFile(res, `microsoft/mailDelta.${m[1]}.${graphSuffix(q)}.json`);
        return;
      }
      m = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(seg);
      if (m !== null) {
        await sendJsonFile(res, `microsoft/messages.${m[1]}.${graphSuffix(q)}.json`, true);
        return;
      }
      m = /^\/me\/messages\/([^/]+)\/\$value$/.exec(seg);
      if (m !== null) {
        await sendBinary(res, `microsoft/message.${m[1]}.eml`, 'message/rfc822');
        return;
      }
      m = /^\/me\/messages\/([^/]+)$/.exec(seg);
      if (m !== null) {
        await sendJsonFile(res, `microsoft/message.${m[1]}.json`);
        return;
      }
      if (seg === '/me/drive') {
        await sendJsonFile(res, 'microsoft/drive.json');
        return;
      }
      if (seg === '/me/drives') {
        await sendJsonFile(res, 'microsoft/drives.json');
        return;
      }
      if (seg === '/me/drive/root/delta') {
        if (q.get('token') === 'expired') {
          sendError(res, 410, 'resyncRequired', 'delta token expired');
          return;
        }
        await sendJsonFile(res, `microsoft/driveDelta.d-1.${graphSuffix(q)}.json`);
        return;
      }
      m = /^\/drives\/([^/]+)\/root\/delta$/.exec(g);
      if (m !== null) {
        if (q.get('token') === 'expired') {
          sendError(res, 410, 'resyncRequired', 'delta token expired');
          return;
        }
        await sendJsonFile(res, `microsoft/driveDelta.${m[1]}.${graphSuffix(q)}.json`);
        return;
      }
      m = /^\/drives\/([^/]+)\/items\/([^/]+)\/content$/.exec(g);
      if (m !== null) {
        res.writeHead(302, {
          location: `${baseUrl}/download/ms/${m[2]}?tempauth=fake-preauth-token-do-not-log`,
        });
        res.end();
        return;
      }
      if (g === '/users') {
        if (q.get('$search') !== null) {
          await sendJsonFile(res, 'microsoft/users.search.json');
          return;
        }
        await sendJsonFile(res, `microsoft/users.${graphSuffix(q)}.json`);
        return;
      }
      sendError(res, 404, 'itemNotFound', 'unknown graph route');
      return;
    }

    // ---- Gmail shaped ----
    if (GMAIL_RE.test(path)) {
      const g = path.replace(GMAIL_RE, '');
      if (g === '/labels') {
        await sendJsonFile(res, 'google/labels.json');
        return;
      }
      if (g === '/messages') {
        await sendJsonFile(res, `google/messages.${googleSuffix(q)}.json`, true);
        return;
      }
      m = /^\/messages\/([^/]+)$/.exec(g);
      if (m !== null) {
        const metaBuf = await readFixture(`google/message.${m[1]}.json`);
        const emlBuf = await readFixture(`google/message.${m[1]}.eml`);
        if (metaBuf === undefined || emlBuf === undefined) {
          sendError(res, 404, 'notFound', 'no such message fixture');
          return;
        }
        const meta = JSON.parse(metaBuf.toString('utf8')) as Record<string, unknown>;
        if (q.get('format') === 'raw') meta['raw'] = emlBuf.toString('base64url');
        sendJson(res, 200, meta);
        return;
      }
      if (g === '/history') {
        if (q.get('startHistoryId') === 'expired') {
          sendError(res, 404, 'notFound', 'history expired');
          return;
        }
        await sendJsonFile(res, `google/history.${googleSuffix(q)}.json`);
        return;
      }
      sendError(res, 404, 'notFound', 'unknown gmail route');
      return;
    }

    // ---- Google Drive shaped ----
    if (path.startsWith('/google/drive/v3/')) {
      const g = path.slice('/google/drive/v3'.length);
      if (g === '/drives') {
        await sendJsonFile(res, `google/drives.${googleSuffix(q)}.json`);
        return;
      }
      if (g === '/changes/startPageToken') {
        await sendJsonFile(res, 'google/startPageToken.json');
        return;
      }
      if (g === '/changes') {
        const token = q.get('pageToken');
        if (token === null) {
          sendError(res, 400, 'badRequest', 'pageToken required');
          return;
        }
        await sendJsonFile(res, `google/changes.${token}.json`);
        return;
      }
      m = /^\/files\/([^/]+)\/export$/.exec(g);
      if (m !== null) {
        if (m[1] === 'gd-huge') {
          sendJson(res, 403, {
            error: {
              code: 403,
              message: 'This file is too large to be exported.',
              errors: [{ reason: 'exportSizeLimitExceeded' }],
            },
          });
          return;
        }
        const mime = q.get('mimeType') ?? '';
        const extByMime: Record<string, string> = {
          'application/pdf': 'pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
        };
        await sendBinary(res, `google/export.${m[1]}.${extByMime[mime] ?? 'bin'}.bin`, mime);
        return;
      }
      m = /^\/files\/([^/]+)$/.exec(g);
      if (m !== null) {
        if (q.get('alt') === 'media') {
          await sendBinary(res, `google/content.${m[1]}.bin`, 'application/octet-stream');
          return;
        }
        await sendJsonFile(res, `google/file.${m[1]}.json`);
        return;
      }
      if (g === '/files') {
        await sendJsonFile(res, `google/files.${googleSuffix(q)}.json`);
        return;
      }
      sendError(res, 404, 'notFound', 'unknown drive route');
      return;
    }

    // ---- Workspace Admin SDK shaped ----
    if (path === '/google/admin/directory/v1/users') {
      if ((q.get('query') ?? '') !== '') {
        await sendJsonFile(res, 'google/users.search.json');
        return;
      }
      await sendJsonFile(res, `google/users.${googleSuffix(q)}.json`);
      return;
    }

    sendError(res, 404, 'notFound', `no route for ${path}`);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error('fake provider server error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { code: 'internalError', message: 'fake server failure' } }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake provider server failed to bind');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    url: baseUrl,
    requests,
    reset(): void {
      requests.length = 0;
      flaked.clear();
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err !== undefined && err !== null ? reject(err) : resolve()));
      });
    },
  };
}
