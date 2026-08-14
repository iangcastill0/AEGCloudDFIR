import { Readable } from 'node:stream';
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
  /** Rejects on the first error; never resolves. Raced against completion. */
  private readonly failure: Promise<never>;
  private failWith!: (err: Error) => void;
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
    this.failure = new Promise<never>((_resolve, reject) => {
      this.failWith = reject;
      output.once('error', reject);
      this.archive.once('error', reject);
    });
    // Nothing awaits `failure` unless finalize() races it, and a successful
    // archive never rejects it — but a rejection with no handler attached would
    // still crash the process, so keep one attached from the start.
    this.failure.catch(() => undefined);
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
    if (source instanceof Readable) {
      source.once('error', (err: unknown) => {
        // archiver does not surface an entry source's error — it emits neither
        // 'error' nor 'warning' and simply stops, so the caller would wait
        // forever. Record it and tear the archive down so no central directory
        // is written for a set that is missing a document.
        this.failWith(err instanceof Error ? err : new Error(String(err)));
        try {
          this.archive.abort();
        } catch {
          // abort() on an already-torn-down archive is not a further failure.
        }
      });
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
    // archiver's finalize() never settles once a queued entry stream has errored,
    // so the error must be able to win: awaiting completion alone hangs the
    // caller forever — an export job or a download that never finishes and never
    // says why.
    await Promise.race([
      (async () => {
        await this.archive.finalize();
        await this.outputDone;
      })(),
      this.failure,
    ]);
    return { entryCount: this.entryCount };
  }
}
