import { createServer, type Server, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvScanner, parseScanResponse, parseVersionResponse } from './clamav.js';

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

interface FakeClamdOptions {
  scanResponse?: string;
  versionResponse?: string;
  /** Never respond (for timeout tests). */
  silent?: boolean;
  onPayload?: (payload: Buffer) => void;
}

/** Minimal clamd: understands zINSTREAM and zVERSION. */
async function startClamd(options: FakeClamdOptions = {}): Promise<number> {
  server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let mode: 'command' | 'instream' = 'command';
    let payload = Buffer.alloc(0);

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (options.silent === true) return;

      if (mode === 'command') {
        const nul = buffer.indexOf(0);
        if (nul === -1) return;
        const command = buffer.subarray(0, nul).toString('utf8');
        buffer = buffer.subarray(nul + 1);
        if (command === 'zVERSION') {
          socket.end(`${options.versionResponse ?? 'ClamAV 1.4.1/27484/Tue Aug 10 08:00:00 2026'}\0`);
          return;
        }
        if (command === 'zINSTREAM') {
          mode = 'instream';
        }
      }

      if (mode === 'instream') {
        // Consume 4-byte BE length-prefixed chunks until the zero terminator.
        for (;;) {
          if (buffer.length < 4) return;
          const length = buffer.readUInt32BE(0);
          if (length === 0) {
            options.onPayload?.(payload);
            socket.end(`${options.scanResponse ?? 'stream: OK'}\0`);
            return;
          }
          if (buffer.length < 4 + length) return;
          payload = Buffer.concat([payload, buffer.subarray(4, 4 + length)]);
          buffer = buffer.subarray(4 + length);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function scanner(port: number, timeoutMs = 2_000): ClamAvScanner {
  return new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs });
}

describe('ClamAvScanner.scan', () => {
  it('returns clean for stream: OK and streams the exact bytes', async () => {
    let received: Buffer | undefined;
    const port = await startClamd({ onPayload: (p) => { received = p; } });
    const bytes = Buffer.from('some evidence file bytes');

    const result = await scanner(port).scan(bytes);
    expect(result).toEqual({ status: 'clean' });
    expect(received?.equals(bytes)).toBe(true);
  });

  it('accepts a Readable stream input', async () => {
    let received: Buffer | undefined;
    const port = await startClamd({ onPayload: (p) => { received = p; } });
    const chunks = [Buffer.from('part-one|'), Buffer.from('part-two')];

    const result = await scanner(port).scan(Readable.from(chunks));
    expect(result.status).toBe('clean');
    expect(received?.toString('utf8')).toBe('part-one|part-two');
  });

  it('returns infected with the signature name on FOUND', async () => {
    const port = await startClamd({ scanResponse: 'stream: Eicar-Test-Signature FOUND' });
    const result = await scanner(port).scan(Buffer.from('eicar'));
    expect(result).toEqual({ status: 'infected', signatureName: 'Eicar-Test-Signature' });
  });

  it('returns scan_failed on ERROR responses', async () => {
    const port = await startClamd({ scanResponse: 'INSTREAM size limit exceeded. ERROR' });
    const result = await scanner(port).scan(Buffer.from('big'));
    expect(result.status).toBe('scan_failed');
    expect(result.message).toContain('ERROR');
  });

  it('returns scan_failed (never throws) when the connection is refused', async () => {
    // Grab a port and close the server so nothing is listening.
    const port = await startClamd();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const result = await scanner(port).scan(Buffer.from('x'));
    expect(result.status).toBe('scan_failed');
    expect(result.message).toBeDefined();
  });

  it('returns scan_failed on timeout', async () => {
    const port = await startClamd({ silent: true });
    const result = await scanner(port, 100).scan(Buffer.from('x'));
    expect(result.status).toBe('scan_failed');
    expect(result.message).toMatch(/timed out/i);
  });
});

describe('ClamAvScanner.version', () => {
  it('parses engine and signature versions', async () => {
    const port = await startClamd({
      versionResponse: 'ClamAV 1.4.1/27484/Tue Aug 10 08:00:00 2026',
    });
    const version = await scanner(port).version();
    expect(version.engineVersion).toBe('1.4.1');
    expect(version.signatureVersion).toBe('27484');
    expect(version.raw).toContain('ClamAV 1.4.1');
  });
});

describe('parseScanResponse', () => {
  it('parses OK / FOUND / ERROR / garbage', () => {
    expect(parseScanResponse('stream: OK')).toEqual({ status: 'clean' });
    expect(parseScanResponse('stream: Win.Test.EICAR_HDB-1 FOUND')).toEqual({
      status: 'infected',
      signatureName: 'Win.Test.EICAR_HDB-1',
    });
    expect(parseScanResponse('stream: Some ERROR').status).toBe('scan_failed');
    expect(parseScanResponse('???').status).toBe('scan_failed');
  });
});

describe('parseVersionResponse', () => {
  it('handles version strings without a signature part', () => {
    const version = parseVersionResponse('ClamAV 1.4.1');
    expect(version.engineVersion).toBe('1.4.1');
    expect(version.signatureVersion).toBe('');
  });
});
