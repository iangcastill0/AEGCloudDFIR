import { BatesOverflowError, BatesParseError, ProductionError } from './errors.js';
import type { BatesConfig } from './types.js';

/**
 * Format a bates number: prefix + zero-padded number + suffix.
 * Throws {@link BatesOverflowError} when the number does not fit in
 * `config.digits` digits.
 */
export function formatBates(config: BatesConfig, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new ProductionError(`bates number must be a positive integer, got ${n}`);
  }
  const digits = String(n);
  if (digits.length > config.digits) {
    throw new BatesOverflowError(
      `bates number ${n} exceeds the configured width of ${config.digits} digits` +
        ` (prefix "${config.prefix}")`,
    );
  }
  return `${config.prefix}${digits.padStart(config.digits, '0')}${config.suffix}`;
}

/**
 * Parse a bates string produced by {@link formatBates} back into its numeric
 * component. Throws {@link BatesParseError} on any mismatch with the config.
 */
export function parseBates(config: BatesConfig, s: string): number {
  if (!s.startsWith(config.prefix)) {
    throw new BatesParseError(`"${s}" does not start with prefix "${config.prefix}"`);
  }
  if (config.suffix.length > 0 && !s.endsWith(config.suffix)) {
    throw new BatesParseError(`"${s}" does not end with suffix "${config.suffix}"`);
  }
  const middle = s.slice(config.prefix.length, s.length - config.suffix.length);
  if (middle.length !== config.digits) {
    throw new BatesParseError(
      `"${s}" has a ${middle.length}-character numeric part, expected ${config.digits}`,
    );
  }
  if (!/^[0-9]+$/.test(middle)) {
    throw new BatesParseError(`"${s}" numeric part "${middle}" contains non-digits`);
  }
  const n = Number.parseInt(middle, 10);
  if (n < 1) {
    throw new BatesParseError(`"${s}" parses to non-positive bates number ${n}`);
  }
  return n;
}

export interface DocumentBatesRange {
  begBates: string;
  endBates: string;
  /** How many bates numbers this document consumed (pageCount for per_page, 1 for per_document). */
  numbersUsed: number;
}

/**
 * In-memory bates allocator for a single production run.
 *
 * Atomic reservation of the underlying number range is the database's job;
 * this class only performs the deterministic per-document math within an
 * already-reserved range.
 */
export class BatesCounter {
  private readonly config: BatesConfig;
  private next: number;

  constructor(config: BatesConfig, startNumber: number) {
    if (!Number.isInteger(startNumber) || startNumber < 1) {
      throw new ProductionError(`startNumber must be a positive integer, got ${startNumber}`);
    }
    this.config = config;
    this.next = startNumber;
    // Fail fast if the starting number already overflows.
    formatBates(config, startNumber);
  }

  /** The bates string the next document (or page) would receive, without consuming it. */
  peekNext(): string {
    return formatBates(this.config, this.next);
  }

  /** The raw numeric value of the next bates number. */
  get nextNumber(): number {
    return this.next;
  }

  /**
   * Allocate bates numbers for one document of `pageCount` pages.
   * per_page numbering consumes one number per page; per_document consumes one
   * number for the whole document. Overflow throws before consuming anything.
   */
  nextDocument(pageCount: number): DocumentBatesRange {
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new ProductionError(`pageCount must be a positive integer, got ${pageCount}`);
    }
    const numbersUsed = this.config.numbering === 'per_page' ? pageCount : 1;
    // Format the end first: if it overflows we throw without mutating state.
    const endBates = formatBates(this.config, this.next + numbersUsed - 1);
    const begBates = formatBates(this.config, this.next);
    this.next += numbersUsed;
    return { begBates, endBates, numbersUsed };
  }
}
