import { describe, expect, it } from 'vitest';
import { QuerySyntaxError } from './errors.js';
import { tokenize } from './lexer.js';

describe('tokenize', () => {
  it('tokenizes bare words', () => {
    expect(tokenize('alpha beta')).toEqual([
      { type: 'word', value: 'alpha', pos: 0 },
      { type: 'word', value: 'beta', pos: 6 },
    ]);
  });

  it('tokenizes quoted phrases', () => {
    expect(tokenize('"quarterly report"')).toEqual([
      { type: 'phrase', value: 'quarterly report', pos: 0 },
    ]);
  });

  it('handles escaped quotes and backslashes inside phrases', () => {
    expect(tokenize('"say \\"hi\\""')).toEqual([{ type: 'phrase', value: 'say "hi"', pos: 0 }]);
    expect(tokenize('"a\\\\b"')).toEqual([{ type: 'phrase', value: 'a\\b', pos: 0 }]);
  });

  it('reads proximity suffix on phrases', () => {
    expect(tokenize('"a b"~5')).toEqual([{ type: 'phrase', value: 'a b', proximity: 5, pos: 0 }]);
  });

  it('rejects a proximity operator without a number', () => {
    expect(() => tokenize('"a b"~')).toThrow(QuerySyntaxError);
  });

  it('throws with the position of an unterminated phrase', () => {
    try {
      tokenize('foo "unterminated');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QuerySyntaxError);
      expect((error as QuerySyntaxError).position).toBe(4);
    }
  });

  it('recognizes uppercase boolean operators as keywords', () => {
    expect(tokenize('a AND b OR NOT c').map((t) => t.type)).toEqual([
      'word',
      'and',
      'word',
      'or',
      'not',
      'word',
    ]);
  });

  it('treats lowercase and/or/not as plain words', () => {
    expect(tokenize('a and b').map((t) => t.type)).toEqual(['word', 'word', 'word']);
  });

  it('supports && and ||', () => {
    expect(tokenize('a && b || c').map((t) => t.type)).toEqual([
      'word',
      'and',
      'word',
      'or',
      'word',
    ]);
  });

  it('rejects single & and |', () => {
    expect(() => tokenize('a & b')).toThrow(QuerySyntaxError);
    expect(() => tokenize('a | b')).toThrow(QuerySyntaxError);
  });

  it('tokenizes fielded terms with colon', () => {
    expect(tokenize('from:alice@example.com')).toEqual([
      { type: 'word', value: 'from', pos: 0 },
      { type: 'colon', pos: 4 },
      { type: 'word', value: 'alice@example.com', pos: 5 },
    ]);
  });

  it('tokenizes comparison operators', () => {
    expect(tokenize('size>=10mb')).toEqual([
      { type: 'word', value: 'size', pos: 0 },
      { type: 'op', op: '>=', pos: 4 },
      { type: 'word', value: '10mb', pos: 6 },
    ]);
    expect(tokenize('sent<2024-01-01').map((t) => (t.type === 'op' ? t.op : t.type))).toEqual([
      'word',
      '<',
      'word',
    ]);
    expect(tokenize('a<=b')[1]).toEqual({ type: 'op', op: '<=', pos: 1 });
    expect(tokenize('a=b')[1]).toEqual({ type: 'op', op: '=', pos: 1 });
  });

  it('tokenizes bracket ranges', () => {
    expect(tokenize('received:[2024-01-01 TO 2024-06-30]').map((t) => t.type)).toEqual([
      'word',
      'colon',
      'lbracket',
      'word',
      'word',
      'word',
      'rbracket',
    ]);
  });

  it('reads fuzzy suffixes', () => {
    expect(tokenize('term~')).toEqual([{ type: 'word', value: 'term', fuzzy: 2, pos: 0 }]);
    expect(tokenize('term~1')).toEqual([{ type: 'word', value: 'term', fuzzy: 1, pos: 0 }]);
  });

  it('rejects a bare fuzzy operator and interior tildes', () => {
    expect(() => tokenize('~2')).toThrow(QuerySyntaxError);
    expect(() => tokenize('a~b')).toThrow(QuerySyntaxError);
  });

  it('keeps wildcards inside words', () => {
    expect(tokenize('repor* fil?.txt')).toEqual([
      { type: 'word', value: 'repor*', pos: 0 },
      { type: 'word', value: 'fil?.txt', pos: 7 },
    ]);
  });

  it('keeps ISO time colons inside a value but still splits field colons', () => {
    expect(tokenize('sent>=2024-01-01T10:30:00Z')).toEqual([
      { type: 'word', value: 'sent', pos: 0 },
      { type: 'op', op: '>=', pos: 4 },
      { type: 'word', value: '2024-01-01T10:30:00Z', pos: 6 },
    ]);
    // A digit-final field name like sha256 must still be split on ":".
    expect(tokenize('sha256:0123abcd').map((t) => t.type)).toEqual(['word', 'colon', 'word']);
  });

  it('returns no tokens for empty and whitespace-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   \t ')).toEqual([]);
  });
});
