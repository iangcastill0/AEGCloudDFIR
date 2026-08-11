import { Socket } from 'node:net';
import type { Readable } from 'node:stream';

/**
 * Minimal clamd protocol client: zVERSION for engine/signature versions and
 * zINSTREAM (4-byte big-endian length-prefixed chunks, zero-length
 * terminator) for streaming scans. No third-party dependency.
 */

export interface ClamScanResult {
  infected: boolean;
  signature: string;
}

export interface ClamVersion {
  engineVersion: string;
  signatureVersion: string;
}

export interface ClamAvClient {
  version(): Promise<ClamVersion>;
  scanStream(data: Readable): Promise<ClamScanResult>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const CHUNK_SIZE = 64 * 1024;

function connect(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('clamd connection timed out'));
    });
    socket.connect(port, host, () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

function readReply(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(buf);
      // z-commands terminate replies with a NUL byte.
      if (buf.includes(0)) {
        socket.end();
      }
    });
    socket.once('end', () =>
      resolve(Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim()),
    );
    socket.once('close', () =>
      resolve(Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim()),
    );
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('clamd read timed out'));
    });
  });
}

export class ClamdClient implements ClamAvClient {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async version(): Promise<ClamVersion> {
    const socket = await connect(this.host, this.port, this.timeoutMs);
    const replyPromise = readReply(socket);
    socket.write('zVERSION\0');
    const reply = await replyPromise;
    // e.g. "ClamAV 1.3.1/27310/Tue Jun 10 08:31:26 2026"
    const [engine, sigs] = reply.split('/');
    return {
      engineVersion: (engine ?? reply).trim(),
      signatureVersion: (sigs ?? '').trim(),
    };
  }

  async scanStream(data: Readable): Promise<ClamScanResult> {
    const socket = await connect(this.host, this.port, this.timeoutMs);
    const replyPromise = readReply(socket);
    socket.write('zINSTREAM\0');

    const writeChunk = (chunk: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.byteLength, 0);
        socket.write(Buffer.concat([size, chunk]), (err) =>
          err !== undefined && err !== null ? reject(err) : resolve(),
        );
      });

    try {
      for await (const raw of data) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        for (let offset = 0; offset < buf.byteLength; offset += CHUNK_SIZE) {
          await writeChunk(buf.subarray(offset, offset + CHUNK_SIZE));
        }
      }
      const terminator = Buffer.alloc(4);
      socket.write(terminator);
    } catch (err) {
      socket.destroy();
      throw err;
    }

    const reply = await replyPromise;
    const found = /:\s(.+)\sFOUND$/.exec(reply);
    if (found !== null) {
      return { infected: true, signature: found[1] ?? 'UNKNOWN' };
    }
    if (/OK$/.test(reply)) {
      return { infected: false, signature: '' };
    }
    throw new Error(`unexpected clamd reply: ${reply.slice(0, 120)}`);
  }
}
