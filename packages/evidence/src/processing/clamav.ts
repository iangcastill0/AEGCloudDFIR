/**
 * ClamAV clamd client speaking the INSTREAM protocol over TCP.
 *
 * Scan results record the malware signature name when found. `version()`
 * returns engine and signature-database versions so every scan can be
 * attributed to exact detection capability in the audit trail.
 *
 * `scan()` NEVER throws: connection failures, timeouts and protocol errors
 * come back as status 'scan_failed' with a message, so a pipeline batch is
 * never crashed by an AV hiccup (the worker decides how to record it).
 */

import { Socket } from 'node:net';
import { Readable } from 'node:stream';

export type ScanStatus = 'clean' | 'infected' | 'scan_failed';

export interface ScanResult {
  status: ScanStatus;
  /** Malware signature name when status is 'infected'. */
  signatureName?: string;
  /** Failure detail when status is 'scan_failed'. */
  message?: string;
}

export interface ClamVersion {
  /** e.g. '1.4.1'. */
  engineVersion: string;
  /** Signature database version, e.g. '27484'. */
  signatureVersion: string;
  /** Full raw VERSION line for the audit record. */
  raw: string;
}

export interface ClamAvScannerOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

const MAX_CHUNK = 64 * 1024;

export class ClamAvScanner {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(options: ClamAvScannerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.timeoutMs = options.timeoutMs;
  }

  /** Scan bytes or a stream via zINSTREAM. Never throws. */
  async scan(input: Buffer | Readable): Promise<ScanResult> {
    let response: string;
    try {
      response = await this.command((socket) => this.streamInstream(socket, input));
    } catch (err) {
      return {
        status: 'scan_failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return parseScanResponse(response);
  }

  /** Query engine + signature versions via zVERSION. */
  async version(): Promise<ClamVersion> {
    const response = await this.command((socket) => {
      socket.write('zVERSION\0');
      return Promise.resolve();
    });
    return parseVersionResponse(response);
  }

  /**
   * Open a connection, run `send`, then collect the NUL-terminated response.
   */
  private command(send: (socket: Socket) => Promise<void>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      let settled = false;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };
      const succeed = (value: string): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(this.timeoutMs, () => fail(new Error('clamd connection timed out')));
      socket.on('error', (err) => fail(err));
      socket.on('data', (data: Buffer) => {
        chunks.push(data);
        const all = Buffer.concat(chunks);
        const nul = all.indexOf(0);
        if (nul !== -1) {
          succeed(all.subarray(0, nul).toString('utf8').trim());
        }
      });
      socket.on('close', () => {
        const all = Buffer.concat(chunks).toString('utf8').replace(/\0.*$/s, '').trim();
        if (all !== '') {
          succeed(all);
        } else {
          fail(new Error('clamd closed the connection without a response'));
        }
      });
      socket.connect(this.port, this.host, () => {
        send(socket).catch((err: unknown) =>
          fail(err instanceof Error ? err : new Error(String(err))),
        );
      });
    });
  }

  private async streamInstream(socket: Socket, input: Buffer | Readable): Promise<void> {
    socket.write('zINSTREAM\0');
    if (Buffer.isBuffer(input)) {
      for (let offset = 0; offset < input.length; offset += MAX_CHUNK) {
        writeChunk(socket, input.subarray(offset, offset + MAX_CHUNK));
      }
    } else {
      for await (const piece of input) {
        const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
        for (let offset = 0; offset < buffer.length; offset += MAX_CHUNK) {
          writeChunk(socket, buffer.subarray(offset, offset + MAX_CHUNK));
        }
      }
    }
    // Zero-length chunk terminates the stream.
    const terminator = Buffer.alloc(4);
    socket.write(terminator);
  }
}

function writeChunk(socket: Socket, chunk: Buffer): void {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(chunk.length, 0);
  socket.write(header);
  socket.write(chunk);
}

/** Parse 'stream: OK' | 'stream: {Sig} FOUND' | '... ERROR'. */
export function parseScanResponse(response: string): ScanResult {
  const trimmed = response.trim();
  if (/^stream:\s*OK$/i.test(trimmed)) {
    return { status: 'clean' };
  }
  const found = /^stream:\s*(.+)\s+FOUND$/i.exec(trimmed);
  if (found?.[1] !== undefined) {
    return { status: 'infected', signatureName: found[1].trim() };
  }
  if (/ERROR$/i.test(trimmed)) {
    return { status: 'scan_failed', message: trimmed };
  }
  return { status: 'scan_failed', message: `unrecognized clamd response: ${trimmed}` };
}

/** Parse 'ClamAV 1.4.1/27484/Tue ...' → engine 1.4.1, signatures 27484. */
export function parseVersionResponse(response: string): ClamVersion {
  const raw = response.trim();
  const match = /^ClamAV\s+([^\s/]+)(?:\/([^/]+))?/i.exec(raw);
  return {
    engineVersion: match?.[1] ?? '',
    signatureVersion: match?.[2] ?? '',
    raw,
  };
}
