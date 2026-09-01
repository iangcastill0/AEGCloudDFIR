import { describe, expect, it } from 'vitest';
import { dropboxApiArg } from './api-arg.js';

/**
 * Dropbox takes its request body in an HTTP HEADER for download and other
 * content endpoints. Headers are ASCII only, so any non-ASCII character in a
 * filename or path has to be escaped or the request is rejected outright — or,
 * worse on some stacks, silently mangled.
 *
 * A custodian's files are full of non-ASCII: accents, emoji, CJK, smart quotes.
 * Getting this wrong means those files cannot be collected at all, and the
 * failure looks like a provider error rather than an encoding bug.
 */
describe('dropboxApiArg', () => {
  it('passes plain ASCII through as ordinary JSON', () => {
    expect(dropboxApiArg({ path: '/Reports/q3.pdf' })).toBe('{"path":"/Reports/q3.pdf"}');
  });

  it('escapes accented characters', () => {
    expect(dropboxApiArg({ path: '/Rapports/résumé.pdf' })).toBe(
      '{"path":"/Rapports/r\\u00e9sum\\u00e9.pdf"}',
    );
  });

  it('escapes CJK', () => {
    expect(dropboxApiArg({ path: '/報告書.docx' })).toBe('{"path":"/\\u5831\\u544a\\u66f8.docx"}');
  });

  it('escapes characters outside the basic plane, as surrogate pairs', () => {
    // Emoji are two UTF-16 code units. Escaping only one of them produces a
    // string Dropbox rejects, and the filename is unrecoverable.
    const encoded = dropboxApiArg({ path: '/holiday 🏝.jpg' });
    expect(encoded).toContain('\\ud83c');
    expect(encoded).toContain('\\udfdd');
    expect(/^[\x20-\x7e]*$/.test(encoded)).toBe(true);
  });

  it('produces header-safe output for every input', () => {
    // The property that actually matters: the result must be printable ASCII,
    // whatever went in.
    for (const path of ['/a', '/Ünïcödé', '/日本語/ファイル.txt', '/emoji 😀😀', '/quote "x"']) {
      const encoded = dropboxApiArg({ path });
      expect(/^[\x20-\x7e]*$/.test(encoded), path).toBe(true);
    }
  });

  it('still round-trips back to the original value', () => {
    // Escaping must be reversible: it is an encoding, not a substitution.
    const original = { path: '/日本語/résumé 🏝.pdf' };
    expect(JSON.parse(dropboxApiArg(original))).toEqual(original);
  });
});
