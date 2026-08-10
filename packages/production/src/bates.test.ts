import { describe, expect, it } from 'vitest';
import { BatesCounter, formatBates, parseBates } from './bates.js';
import { BatesOverflowError, BatesParseError, ProductionError } from './errors.js';
import type { BatesConfig } from './types.js';

const perPage: BatesConfig = { prefix: 'ABC', digits: 8, suffix: '', numbering: 'per_page' };
const perDoc: BatesConfig = { prefix: 'DEF-', digits: 6, suffix: '-X', numbering: 'per_document' };

describe('formatBates', () => {
  it('zero-pads to the configured digit width', () => {
    expect(formatBates(perPage, 1)).toBe('ABC00000001');
    expect(formatBates(perPage, 12345678)).toBe('ABC12345678');
  });

  it('applies prefix and suffix', () => {
    expect(formatBates(perDoc, 42)).toBe('DEF-000042-X');
  });

  it('throws BatesOverflowError when the number exceeds the digit width', () => {
    expect(() => formatBates(perPage, 100000000)).toThrow(BatesOverflowError);
    expect(() => formatBates(perDoc, 1000000)).toThrow(BatesOverflowError);
  });

  it('rejects non-positive and non-integer numbers', () => {
    expect(() => formatBates(perPage, 0)).toThrow(ProductionError);
    expect(() => formatBates(perPage, -3)).toThrow(ProductionError);
    expect(() => formatBates(perPage, 1.5)).toThrow(ProductionError);
  });
});

describe('parseBates', () => {
  it('round-trips with formatBates', () => {
    for (const n of [1, 7, 999, 99999999]) {
      expect(parseBates(perPage, formatBates(perPage, n))).toBe(n);
    }
    for (const n of [1, 500, 999999]) {
      expect(parseBates(perDoc, formatBates(perDoc, n))).toBe(n);
    }
  });

  it('rejects wrong prefix, suffix, width, and non-digits', () => {
    expect(() => parseBates(perPage, 'XYZ00000001')).toThrow(BatesParseError);
    expect(() => parseBates(perDoc, 'DEF-000042-Y')).toThrow(BatesParseError);
    expect(() => parseBates(perPage, 'ABC0000001')).toThrow(BatesParseError); // 7 digits
    expect(() => parseBates(perPage, 'ABC0000000a')).toThrow(BatesParseError);
  });
});

describe('BatesCounter', () => {
  it('counts per page: a document consumes one number per page', () => {
    const counter = new BatesCounter(perPage, 1);
    expect(counter.peekNext()).toBe('ABC00000001');
    const doc1 = counter.nextDocument(3);
    expect(doc1).toEqual({
      begBates: 'ABC00000001',
      endBates: 'ABC00000003',
      numbersUsed: 3,
    });
    const doc2 = counter.nextDocument(1);
    expect(doc2).toEqual({
      begBates: 'ABC00000004',
      endBates: 'ABC00000004',
      numbersUsed: 1,
    });
  });

  it('counts per document: one number regardless of page count', () => {
    const counter = new BatesCounter(perDoc, 10);
    const doc1 = counter.nextDocument(25);
    expect(doc1).toEqual({
      begBates: 'DEF-000010-X',
      endBates: 'DEF-000010-X',
      numbersUsed: 1,
    });
    expect(counter.nextDocument(2).begBates).toBe('DEF-000011-X');
  });

  it('keeps ranges contiguous across many documents', () => {
    const counter = new BatesCounter(perPage, 500);
    let expectedNext = 500;
    for (const pages of [1, 5, 2, 17, 1, 3]) {
      const { begBates, endBates, numbersUsed } = counter.nextDocument(pages);
      expect(parseBates(perPage, begBates)).toBe(expectedNext);
      expect(parseBates(perPage, endBates)).toBe(expectedNext + pages - 1);
      expect(numbersUsed).toBe(pages);
      expectedNext += pages;
    }
    expect(counter.nextNumber).toBe(expectedNext);
  });

  it('throws on overflow without consuming numbers', () => {
    const config: BatesConfig = { prefix: 'P', digits: 4, suffix: '', numbering: 'per_page' };
    const counter = new BatesCounter(config, 9998);
    expect(() => counter.nextDocument(5)).toThrow(BatesOverflowError);
    // State unchanged: a smaller document still starts at 9998.
    expect(counter.nextDocument(2)).toEqual({
      begBates: 'P9998',
      endBates: 'P9999',
      numbersUsed: 2,
    });
    expect(() => counter.nextDocument(1)).toThrow(BatesOverflowError);
  });

  it('rejects invalid start numbers and page counts', () => {
    expect(() => new BatesCounter(perPage, 0)).toThrow(ProductionError);
    expect(() => new BatesCounter(perPage, 2.5)).toThrow(ProductionError);
    const counter = new BatesCounter(perPage, 1);
    expect(() => counter.nextDocument(0)).toThrow(ProductionError);
    expect(() => counter.nextDocument(-1)).toThrow(ProductionError);
    expect(() => counter.nextDocument(1.2)).toThrow(ProductionError);
  });

  it('throws immediately when startNumber already overflows', () => {
    const config: BatesConfig = { prefix: 'P', digits: 4, suffix: '', numbering: 'per_page' };
    expect(() => new BatesCounter(config, 10000)).toThrow(BatesOverflowError);
  });
});
