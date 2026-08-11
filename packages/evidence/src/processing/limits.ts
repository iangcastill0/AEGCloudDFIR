/**
 * Archive-bomb guards for decompression.
 *
 * Callers construct one ExpansionGuard per evidence item from the deployment
 * configuration and thread it through every nested extraction:
 *
 * - maxDepth        ← EV_MAX_ARCHIVE_DEPTH
 * - maxRatio        ← EV_MAX_ARCHIVE_EXPANSION_RATIO
 * - maxTotalBytes   ← EV_MAX_ARCHIVE_TOTAL_BYTES
 *
 * The guard is cumulative across all entries of all nested archives of one
 * item, so a thousand small "innocent" entries cannot sum past the limits.
 */

import { gunzipSync } from 'node:zlib';
import { ArchiveBombError, ArchiveDepthExceededError } from './errors.js';

export interface ExpansionGuardOptions {
  /** Maximum nested-archive depth (EV_MAX_ARCHIVE_DEPTH). */
  maxDepth: number;
  /** Maximum output/input expansion ratio (EV_MAX_ARCHIVE_EXPANSION_RATIO). */
  maxRatio: number;
  /** Maximum cumulative decompressed bytes (EV_MAX_ARCHIVE_TOTAL_BYTES). */
  maxTotalBytes: number;
  /** Compressed size of the original evidence object. */
  inputSize: number;
}

/** Handle returned by enterArchive(); call exit() when leaving the archive. */
export interface ArchiveScope {
  exit(): void;
}

export class ExpansionGuard {
  private readonly maxDepth: number;
  private readonly maxRatio: number;
  private readonly maxTotalBytes: number;
  private readonly inputSize: number;
  private depth = 0;
  private totalOut = 0;

  constructor(options: ExpansionGuardOptions) {
    this.maxDepth = options.maxDepth;
    this.maxRatio = options.maxRatio;
    this.maxTotalBytes = options.maxTotalBytes;
    this.inputSize = Math.max(1, options.inputSize);
  }

  /** Cumulative decompressed bytes so far. */
  get totalOutputBytes(): number {
    return this.totalOut;
  }

  /** Current nesting depth. */
  get currentDepth(): number {
    return this.depth;
  }

  /** Remaining output budget before either limit trips. */
  get remainingBytes(): number {
    const byTotal = this.maxTotalBytes - this.totalOut;
    const byRatio = Math.floor(this.maxRatio * this.inputSize) - this.totalOut;
    return Math.max(0, Math.min(byTotal, byRatio));
  }

  /**
   * Enter a (nested) archive. Throws ArchiveDepthExceededError when nesting
   * exceeds maxDepth. Call exit() on the returned scope when done.
   */
  enterArchive(): ArchiveScope {
    this.depth += 1;
    if (this.depth > this.maxDepth) {
      this.depth -= 1;
      throw new ArchiveDepthExceededError(
        `archive nesting exceeded maximum depth of ${this.maxDepth}`,
        { maxDepth: this.maxDepth },
      );
    }
    let exited = false;
    return {
      exit: () => {
        if (exited) return;
        exited = true;
        this.depth -= 1;
      },
    };
  }

  /**
   * Record decompressed output. Throws ArchiveBombError when the cumulative
   * output exceeds the absolute cap or the expansion ratio.
   */
  addOutputBytes(n: number): void {
    if (!Number.isFinite(n) || n < 0) {
      throw new TypeError('addOutputBytes requires a non-negative finite number');
    }
    this.totalOut += n;
    if (this.totalOut > this.maxTotalBytes) {
      throw new ArchiveBombError(`decompressed output exceeded ${this.maxTotalBytes} bytes`, {
        maxTotalBytes: this.maxTotalBytes,
        totalOut: this.totalOut,
      });
    }
    const ratio = this.totalOut / this.inputSize;
    if (ratio > this.maxRatio) {
      throw new ArchiveBombError(
        `expansion ratio ${ratio.toFixed(1)} exceeded maximum of ${this.maxRatio}`,
        { maxRatio: this.maxRatio, totalOut: this.totalOut, inputSize: this.inputSize },
      );
    }
  }
}

/**
 * Gunzip with a hard output cap wired into the guard: zlib stops inflating
 * at the guard's remaining budget (never materializing the bomb), and the
 * decompressed size is charged to the guard.
 */
export function gunzipCapped(bytes: Buffer, guard: ExpansionGuard): Buffer {
  const budget = guard.remainingBytes;
  let out: Buffer;
  try {
    // +1 so an exactly-at-budget payload succeeds and one byte more trips
    // zlib's cap instead of allocating unbounded memory.
    out = gunzipSync(bytes, { maxOutputLength: budget + 1 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength/i.test(message)) {
      throw new ArchiveBombError(`gzip output exceeded remaining budget of ${budget} bytes`, {
        budget,
      });
    }
    throw err;
  }
  guard.addOutputBytes(out.length);
  return out;
}
