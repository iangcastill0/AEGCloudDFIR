import { describe, expect, it } from 'vitest';
import { QuerySyntaxError, QueryValidationError } from './errors.js';
import { astFromBuilder, parseQuery, type QueryNode } from './parser.js';

describe('parseQuery', () => {
  it('parses a single term', () => {
    expect(parseQuery('invoice')).toEqual({ kind: 'term', value: 'invoice' });
  });

  it('parses an empty query as match_all', () => {
    expect(parseQuery('')).toEqual({ kind: 'match_all' });
    expect(parseQuery('   ')).toEqual({ kind: 'match_all' });
  });

  it('treats adjacency as implicit AND', () => {
    expect(parseQuery('alpha beta')).toEqual({
      kind: 'and',
      children: [
        { kind: 'term', value: 'alpha' },
        { kind: 'term', value: 'beta' },
      ],
    });
  });

  it('gives AND higher precedence than OR', () => {
    expect(parseQuery('a OR b AND c')).toEqual({
      kind: 'or',
      children: [
        { kind: 'term', value: 'a' },
        {
          kind: 'and',
          children: [
            { kind: 'term', value: 'b' },
            { kind: 'term', value: 'c' },
          ],
        },
      ],
    });
  });

  it('gives NOT higher precedence than AND', () => {
    expect(parseQuery('NOT a AND b')).toEqual({
      kind: 'and',
      children: [
        { kind: 'not', child: { kind: 'term', value: 'a' } },
        { kind: 'term', value: 'b' },
      ],
    });
  });

  it('parses nested parentheses', () => {
    expect(parseQuery('(a OR (b AND c)) d')).toEqual({
      kind: 'and',
      children: [
        {
          kind: 'or',
          children: [
            { kind: 'term', value: 'a' },
            {
              kind: 'and',
              children: [
                { kind: 'term', value: 'b' },
                { kind: 'term', value: 'c' },
              ],
            },
          ],
        },
        { kind: 'term', value: 'd' },
      ],
    });
  });

  it('parses NOT of a group', () => {
    expect(parseQuery('NOT (a OR b)')).toEqual({
      kind: 'not',
      child: {
        kind: 'or',
        children: [
          { kind: 'term', value: 'a' },
          { kind: 'term', value: 'b' },
        ],
      },
    });
  });

  it('parses double negation', () => {
    expect(parseQuery('NOT NOT a')).toEqual({
      kind: 'not',
      child: { kind: 'not', child: { kind: 'term', value: 'a' } },
    });
  });

  it('parses phrases and proximity', () => {
    expect(parseQuery('"quarterly report"')).toEqual({
      kind: 'phrase',
      value: 'quarterly report',
    });
    expect(parseQuery('"a b"~5')).toEqual({ kind: 'phrase', value: 'a b', proximity: 5 });
  });

  it('parses fielded terms and lowercases field names', () => {
    expect(parseQuery('FROM:alice@example.com')).toEqual({
      kind: 'term',
      field: 'from',
      value: 'alice@example.com',
    });
  });

  it('parses fielded phrases', () => {
    expect(parseQuery('subject:"quarterly report"')).toEqual({
      kind: 'phrase',
      field: 'subject',
      value: 'quarterly report',
    });
  });

  it('parses fielded phrases with proximity', () => {
    expect(parseQuery('body:"wire transfer"~3')).toEqual({
      kind: 'phrase',
      field: 'body',
      value: 'wire transfer',
      proximity: 3,
    });
  });

  it('parses bracket ranges', () => {
    expect(parseQuery('received:[2024-01-01 TO 2024-06-30]')).toEqual({
      kind: 'range',
      field: 'received',
      gte: '2024-01-01',
      lte: '2024-06-30',
    });
  });

  it('parses open-ended bracket ranges with *', () => {
    expect(parseQuery('size:[1kb TO *]')).toEqual({ kind: 'range', field: 'size', gte: '1kb' });
    expect(parseQuery('sent:[* TO 2024-06-30]')).toEqual({
      kind: 'range',
      field: 'sent',
      lte: '2024-06-30',
    });
  });

  it('parses all comparison operators', () => {
    expect(parseQuery('sent>=2024-01-01')).toEqual({
      kind: 'range',
      field: 'sent',
      gte: '2024-01-01',
    });
    expect(parseQuery('sent<=2024-01-01')).toEqual({
      kind: 'range',
      field: 'sent',
      lte: '2024-01-01',
    });
    expect(parseQuery('size>10mb')).toEqual({ kind: 'range', field: 'size', gt: '10mb' });
    expect(parseQuery('size<10mb')).toEqual({ kind: 'range', field: 'size', lt: '10mb' });
    expect(parseQuery('ext=pdf')).toEqual({ kind: 'term', field: 'ext', value: 'pdf' });
  });

  it('parses fuzzy terms', () => {
    expect(parseQuery('receit~')).toEqual({ kind: 'term', value: 'receit', fuzzy: 2 });
    expect(parseQuery('receit~1')).toEqual({ kind: 'term', value: 'receit', fuzzy: 1 });
    expect(parseQuery('name:receit~1')).toEqual({
      kind: 'term',
      field: 'name',
      value: 'receit',
      fuzzy: 1,
    });
  });

  it('parses wildcard terms', () => {
    expect(parseQuery('repor*')).toEqual({ kind: 'wildcard', value: 'repor*' });
    expect(parseQuery('name:fil?.txt')).toEqual({
      kind: 'wildcard',
      field: 'name',
      value: 'fil?.txt',
    });
  });

  it('parses field:* as exists', () => {
    expect(parseQuery('from:*')).toEqual({ kind: 'exists', field: 'from' });
  });

  it('parses a realistic combined query', () => {
    expect(
      parseQuery('from:alice@example.com AND (subject:"quarterly report" OR ocr:"account number") NOT tag:reviewed'),
    ).toEqual({
      kind: 'and',
      children: [
        { kind: 'term', field: 'from', value: 'alice@example.com' },
        {
          kind: 'or',
          children: [
            { kind: 'phrase', field: 'subject', value: 'quarterly report' },
            { kind: 'phrase', field: 'ocr', value: 'account number' },
          ],
        },
        { kind: 'not', child: { kind: 'term', field: 'tag', value: 'reviewed' } },
      ],
    });
  });

  describe('syntax errors', () => {
    function positionOf(query: string): number {
      try {
        parseQuery(query);
      } catch (error) {
        expect(error).toBeInstanceOf(QuerySyntaxError);
        return (error as QuerySyntaxError).position;
      }
      return expect.unreachable() as never;
    }

    it('reports unbalanced parentheses with position', () => {
      expect(positionOf('(a OR b')).toBe(7);
      expect(() => parseQuery('a )')).toThrow(QuerySyntaxError);
    });

    it('reports unterminated quotes with position', () => {
      expect(positionOf('foo "bar')).toBe(4);
    });

    it('rejects dangling boolean operators', () => {
      expect(() => parseQuery('a AND')).toThrow(QuerySyntaxError);
      expect(() => parseQuery('OR a')).toThrow(QuerySyntaxError);
      expect(() => parseQuery('NOT')).toThrow(QuerySyntaxError);
    });

    it('rejects a field with no value', () => {
      expect(() => parseQuery('from:')).toThrow(QuerySyntaxError);
      expect(() => parseQuery('from: AND b')).toThrow(QuerySyntaxError);
    });

    it('rejects malformed ranges', () => {
      expect(() => parseQuery('received:[2024-01-01 TO')).toThrow(QuerySyntaxError);
      expect(() => parseQuery('received:[2024-01-01 2024-06-30]')).toThrow(QuerySyntaxError);
      expect(() => parseQuery('received:[* TO *]')).toThrow(QuerySyntaxError);
    });

    it('rejects a comparison with no value', () => {
      expect(() => parseQuery('size>')).toThrow(QuerySyntaxError);
    });
  });
});

describe('astFromBuilder', () => {
  it('produces the same AST as the equivalent string query', () => {
    const fromString = parseQuery('from:alice@example.com AND subject:"quarterly report"');
    const fromBuilder = astFromBuilder({
      op: 'and',
      children: [
        { field: 'from', operator: 'equals', value: 'alice@example.com' },
        { field: 'subject', operator: 'phrase', value: 'quarterly report' },
      ],
    });
    expect(fromBuilder).toEqual(fromString);
  });

  it('matches string parsing for negated groups', () => {
    const fromString = parseQuery('NOT (a OR b)');
    const fromBuilder = astFromBuilder({
      op: 'or',
      not: true,
      children: [
        { operator: 'contains', value: 'a' },
        { operator: 'contains', value: 'b' },
      ],
    });
    expect(fromBuilder).toEqual(fromString);
  });

  it('matches string parsing for starts_with, fuzzy, proximity and ranges', () => {
    expect(
      astFromBuilder({
        op: 'and',
        children: [{ field: 'name', operator: 'starts_with', value: 'rep' }],
      }),
    ).toEqual(parseQuery('name:rep*'));

    expect(
      astFromBuilder({
        op: 'and',
        children: [{ field: 'name', operator: 'fuzzy', value: 'receit' }],
      }),
    ).toEqual(parseQuery('name:receit~'));

    expect(
      astFromBuilder({
        op: 'and',
        children: [{ field: 'body', operator: 'proximity', value: 'wire transfer', distance: 3 }],
      }),
    ).toEqual(parseQuery('body:"wire transfer"~3'));

    expect(
      astFromBuilder({
        op: 'and',
        children: [{ field: 'size', operator: 'range', range: { gt: '10mb' } }],
      }),
    ).toEqual(parseQuery('size>10mb'));

    expect(
      astFromBuilder({
        op: 'and',
        children: [{ field: 'from', operator: 'exists' }],
      }),
    ).toEqual(parseQuery('from:*'));
  });

  it('unwraps single-child groups like the string parser does', () => {
    expect(
      astFromBuilder({ op: 'and', children: [{ operator: 'contains', value: 'x' }] }),
    ).toEqual({ kind: 'term', value: 'x' });
  });

  it('preserves nested group structure', () => {
    const ast = astFromBuilder({
      op: 'or',
      children: [
        { field: 'from', operator: 'equals', value: 'a@x.com' },
        {
          op: 'and',
          children: [
            { operator: 'contains', value: 'alpha' },
            { operator: 'contains', value: 'beta' },
          ],
        },
      ],
    });
    expect(ast).toEqual(parseQuery('from:a@x.com OR (alpha AND beta)'));
  });

  it('rejects invalid builder JSON', () => {
    expect(() => astFromBuilder(null)).toThrow(QueryValidationError);
    expect(() => astFromBuilder({ op: 'xor', children: [] })).toThrow(QueryValidationError);
    expect(() => astFromBuilder({ op: 'and', children: [] })).toThrow(QueryValidationError);
    expect(() =>
      astFromBuilder({ op: 'and', children: [{ operator: 'regex', value: '.*' }] }),
    ).toThrow(QueryValidationError);
    expect(() =>
      astFromBuilder({ op: 'and', children: [{ operator: 'contains' }] }),
    ).toThrow(QueryValidationError);
    expect(() =>
      astFromBuilder({ op: 'and', children: [{ operator: 'range', field: 'size' }] }),
    ).toThrow(QueryValidationError);
    expect(() =>
      astFromBuilder({ op: 'and', children: [{ operator: 'exists' }] }),
    ).toThrow(QueryValidationError);
  });

  it('injects extra unknown keys nowhere (strict schema)', () => {
    expect(() =>
      astFromBuilder({
        op: 'and',
        children: [{ operator: 'contains', value: 'x', script: 'evil' }],
      }),
    ).toThrow(QueryValidationError);
  });

  const roundTripCases: [string, unknown][] = [
    [
      'a AND b OR c',
      {
        op: 'or',
        children: [
          {
            op: 'and',
            children: [
              { operator: 'contains', value: 'a' },
              { operator: 'contains', value: 'b' },
            ],
          },
          { operator: 'contains', value: 'c' },
        ],
      },
    ],
  ];

  it.each(roundTripCases)('string %s equals its builder form', (query, builder) => {
    const expected: QueryNode = parseQuery(query);
    expect(astFromBuilder(builder)).toEqual(expected);
  });
});
