import type { Readable } from 'node:stream';
import { ZipArchive } from 'archiver';
import { ProductionError } from './errors.js';

export interface ProductionArchiveWriterOptions {
  /** zlib compression level 0..9. Default 6. */
  zlibLevel?: number;
}

export interface ArchiveFinalizeResult {
  entryCount: number;
}

/**
 * Streaming ZIP64 assembler for production deliverables. Wraps archiver with
 * forceZip64 so archives beyond 4 GiB / 65k entries stay valid. Callers pipe
 * to any writable (file, S3 multipart upload, HTTP response).
 */
export class ProductionArchiveWriter {
  private readonly archive: ZipArchive;
  private readonly outputDone: Promise<void>;
  private entryCount = 0;
  private finalized = false;

  constructor(output: NodeJS.WritableStream, options: ProductionArchiveWriterOptions = {}) {
    const level = options.zlibLevel ?? 6;
    if (!Number.isInteger(level) || level < 0 || level > 9) {
      throw new ProductionError(`zlibLevel must be an integer 0..9, got ${level}`);
    }
    this.archive = new ZipArchive({ zlib: { level }, forceZip64: true });
    this.outputDone = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      output.once('close', () => settle(resolve));
      output.once('finish', () => settle(resolve));
      output.once('error', (err: Error) => settle(() => reject(err)));
      this.archive.once('error', (err: Error) => settle(() => reject(err)));
    });
    this.archive.pipe(output);
  }

  /** Queue one entry. Source may be a Buffer, string, or readable stream. */
  append(path: string, source: Buffer | Readable | string): void {
    if (this.finalized) {
      throw new ProductionError('cannot append to a finalized archive');
    }
    if (path.length === 0 || path.startsWith('/') || path.includes('..')) {
      throw new ProductionError(`invalid archive entry path: "${path}"`);
    }
    this.archive.append(source, { name: path });
    this.entryCount += 1;
  }

  /** Flush all entries and wait for the output stream to complete. */
  async finalize(): Promise<ArchiveFinalizeResult> {
    if (this.finalized) {
      throw new ProductionError('archive already finalized');
    }
    this.finalized = true;
    await this.archive.finalize();
    await this.outputDone;
    return { entryCount: this.entryCount };
  }
}
