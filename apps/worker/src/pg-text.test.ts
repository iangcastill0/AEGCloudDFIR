import { describe, expect, it } from 'vitest';
import { pgText, pgTextList, pgTextOrNull } from './pg-text';

/** Built, not typed: a literal NUL would be invisible in this file. */
const NUL = String.fromCharCode(0);

describe('pgText', () => {
  it('removes a NUL byte, which PostgreSQL refuses to store', () => {
    // The real failure, on live Gmail data: `invalid byte sequence for encoding
    // "UTF8": 0x00` out of emailMetadata.upsert.
    expect(pgText(`Q3 numbers${NUL}`)).toBe('Q3 numbers');
    expect(pgText(`a${NUL}b${NUL}c`)).toBe('abc');
  });

  it('leaves ordinary text exactly as it was', () => {
    // The same string back — not one that lost accents or emoji. A reviewer may
    // quote this text in a production.
    for (const s of ['Q3 numbers', 'café — naïve', '日本語', '👍 done', '', ' \t\n ']) {
      expect(pgText(s)).toBe(s);
    }
  });

  it('keeps tabs and newlines, which Postgres accepts', () => {
    // Only NUL is rejected. Stripping more would silently alter evidence text.
    expect(pgText('line\ntwo\nthree')).toBe('line\ntwo\nthree');
    expect(pgText('tab\there')).toBe('tab\there');
  });

  it('handles a string that is nothing but NULs', () => {
    expect(pgText(`${NUL}${NUL}`)).toBe('');
  });
});

describe('pgTextOrNull', () => {
  it('passes null and undefined through as null', () => {
    expect(pgTextOrNull(null)).toBeNull();
    expect(pgTextOrNull(undefined)).toBeNull();
  });

  it('cleans a present value', () => {
    expect(pgTextOrNull(`x${NUL}y`)).toBe('xy');
  });
});

describe('pgTextList', () => {
  it('cleans every entry and drops ones that were only NULs', () => {
    expect(pgTextList([`a${NUL}`, NUL, 'b'])).toEqual(['a', 'b']);
  });
});
