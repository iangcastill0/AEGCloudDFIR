import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EncryptedContentError,
  TextExtractionTooLargeError,
  UnsupportedFormatError,
} from './errors.js';
import { TikaClient } from './tika-client.js';

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function startServer(
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function client(baseUrl: string, overrides: Partial<{ timeoutMs: number; maxBytes: number }> = {}): TikaClient {
  return new TikaClient({
    baseUrl,
    timeoutMs: overrides.timeoutMs ?? 2_000,
    maxBytes: overrides.maxBytes ?? 1024 * 1024,
  });
}

describe('TikaClient.extractText', () => {
  it('PUTs bytes to /tika with Accept: text/plain and returns the text', async () => {
    let seenMethod = '';
    let seenUrl = '';
    let seenAccept = '';
    let seenContentType = '';
    const baseUrl = await startServer((req, res) => {
      seenMethod = req.method ?? '';
      seenUrl = req.url ?? '';
      seenAccept = req.headers.accept ?? '';
      seenContentType = req.headers['content-type'] ?? '';
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Extracted document text.');
      });
    });

    const text = await client(baseUrl).extractText(Buffer.from('%PDF-1.4'), 'application/pdf');
    expect(text).toBe('Extracted document text.');
    expect(seenMethod).toBe('PUT');
    expect(seenUrl).toBe('/tika');
    expect(seenAccept).toBe('text/plain');
    expect(seenContentType).toBe('application/pdf');
  });

  it('maps 422 to UnsupportedFormatError', async () => {
    const baseUrl = await startServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(422);
        res.end('Unprocessable Entity');
      });
    });
    await expect(client(baseUrl).extractText(Buffer.from('garbage'))).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
  });

  it('maps EncryptedDocumentException bodies to EncryptedContentError (never brute forces)', async () => {
    const baseUrl = await startServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(422);
        res.end('org.apache.tika.exception.EncryptedDocumentException: cannot decrypt');
      });
    });
    await expect(client(baseUrl).extractText(Buffer.from('encrypted'))).rejects.toBeInstanceOf(
      EncryptedContentError,
    );
  });

  it('aborts when the server exceeds the timeout', async () => {
    const baseUrl = await startServer((req, res) => {
      // Never respond within the timeout window.
      const timer = setTimeout(() => {
        res.writeHead(200);
        res.end('too late');
      }, 5_000);
      res.on('close', () => clearTimeout(timer));
    });
    await expect(
      client(baseUrl, { timeoutMs: 100 }).extractText(Buffer.from('slow')),
    ).rejects.toThrow(/abort|timed out/i);
  });

  it('throws TextExtractionTooLargeError when the response exceeds maxBytes', async () => {
    const baseUrl = await startServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        // Stream well past the cap.
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        for (let i = 0; i < 64; i += 1) res.write(chunk);
        res.end();
      });
    });
    await expect(
      client(baseUrl, { maxBytes: 128 * 1024 }).extractText(Buffer.from('big')),
    ).rejects.toBeInstanceOf(TextExtractionTooLargeError);
  });
});

describe('TikaClient.extractMetadata', () => {
  it('PUTs to /meta with Accept: application/json and parses the result', async () => {
    let seenUrl = '';
    let seenAccept = '';
    const baseUrl = await startServer((req, res) => {
      seenUrl = req.url ?? '';
      seenAccept = req.headers.accept ?? '';
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 'Content-Type': 'application/pdf', 'pdf:encrypted': 'false' }));
      });
    });

    const meta = await client(baseUrl).extractMetadata(Buffer.from('%PDF-1.4'));
    expect(seenUrl).toBe('/meta');
    expect(seenAccept).toBe('application/json');
    expect(meta['Content-Type']).toBe('application/pdf');
  });
});
