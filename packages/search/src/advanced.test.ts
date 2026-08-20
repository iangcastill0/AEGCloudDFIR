import { describe, expect, it } from 'vitest';
import { ADVANCED_PARAMETERS, parseAdvancedQuery } from './advanced.js';
import { parseQuery } from './parser.js';
import { QuerySyntaxError, QueryValidationError } from './errors.js';

/**
 * The advanced language is a second spelling of the SAME query model, so most
 * tests assert the AST it produces — and several assert it matches what the
 * existing `field:value` language produces for an equivalent query. That
 * equivalence is the point: everything after the AST (cost limits, the tenant
 * filter) is shared, so a second front end cannot widen what a query can reach.
 */
describe('parseAdvancedQuery — basics', () => {
  it('CONTAINS with a bare word matches the simple language exactly', () => {
    expect(parseAdvancedQuery('body CONTAINS insurance')).toEqual(parseQuery('body:insurance'));
  });

  it('CONTAINS with a quoted phrase keeps it a phrase', () => {
    expect(parseAdvancedQuery('subject CONTAINS "quarterly report"')).toEqual({
      kind: 'phrase',
      field: 'subject',
      value: 'quarterly report',
    });
  });

  it('carries a slop value through, as the document describes', () => {
    // "phrase"~3 — words may be up to 3 moves out of position.
    expect(parseAdvancedQuery('body CONTAINS "wire transfer"~3')).toEqual({
      kind: 'phrase',
      field: 'body',
      value: 'wire transfer',
      proximity: 3,
    });
  });

  it('IS on a keyword field produces the same term as field:value', () => {
    expect(parseAdvancedQuery('tags IS Documentation')).toEqual(parseQuery('tags:Documentation'));
  });

  it('DOES NOT CONTAIN negates', () => {
    expect(parseAdvancedQuery('body DOES NOT CONTAIN draft')).toEqual({
      kind: 'not',
      child: { kind: 'term', field: 'body', value: 'draft' },
    });
  });

  it('IS NOT negates', () => {
    expect(parseAdvancedQuery('custodian IS NOT dana@example.com')).toEqual({
      kind: 'not',
      child: { kind: 'term', field: 'custodian', value: 'dana@example.com' },
    });
  });

  it('EXISTS and DOES NOT EXIST', () => {
    expect(parseAdvancedQuery('bates EXISTS')).toEqual({ kind: 'exists', field: 'bates' });
    expect(parseAdvancedQuery('bates DOES NOT EXIST')).toEqual({
      kind: 'not',
      child: { kind: 'exists', field: 'bates' },
    });
  });

  it('comparisons on dates and sizes match the simple language', () => {
    expect(parseAdvancedQuery('date > 2026-01-01')).toEqual(parseQuery('date>2026-01-01'));
    expect(parseAdvancedQuery('size >= 1000000')).toEqual(parseQuery('size>=1000000'));
    expect(parseAdvancedQuery('date = 2026-01-01')).toEqual(parseQuery('date=2026-01-01'));
  });

  it('an empty query matches everything, not nothing', () => {
    expect(parseAdvancedQuery('   ')).toEqual({ kind: 'match_all' });
  });
});

describe('parseAdvancedQuery — operators and grouping', () => {
  it('AND, OR and parentheses group as written', () => {
    expect(
      parseAdvancedQuery('(body CONTAINS invoice OR body CONTAINS receipt) AND tags IS Hot'),
    ).toEqual({
      kind: 'and',
      children: [
        {
          kind: 'or',
          children: [
            { kind: 'term', field: 'body', value: 'invoice' },
            { kind: 'term', field: 'body', value: 'receipt' },
          ],
        },
        { kind: 'term', field: 'tags', value: 'Hot' },
      ],
    });
  });

  it('OR binds looser than AND, as in the simple language', () => {
    expect(parseAdvancedQuery('tags IS a AND tags IS b OR tags IS c')).toEqual(
      parseQuery('(tags:a AND tags:b) OR tags:c'),
    );
  });

  it('NOT applies to a whole parenthesised group', () => {
    expect(parseAdvancedQuery('NOT (tags IS a OR tags IS b)')).toEqual({
      kind: 'not',
      child: {
        kind: 'or',
        children: [
          { kind: 'term', field: 'tags', value: 'a' },
          { kind: 'term', field: 'tags', value: 'b' },
        ],
      },
    });
  });

  it('requires an explicit operator between conditions', () => {
    // Adjacency means AND in the simple language; here it is almost always a
    // typo, and guessing would silently change what a reviewer searched.
    expect(() => parseAdvancedQuery('tags IS a tags IS b')).toThrow(QuerySyntaxError);
  });
});

describe('parseAdvancedQuery — complex operators', () => {
  it('IS ANY OF expands to OR, exactly like separate conditions', () => {
    expect(parseAdvancedQuery('tags IS ANY OF (Documentation, "From Zips", Important)')).toEqual(
      parseQuery('tags:Documentation OR tags:"From Zips" OR tags:Important'),
    );
  });

  it('IS ALL OF expands to AND', () => {
    expect(parseAdvancedQuery('tags IS ALL OF (a, b)')).toEqual(parseQuery('tags:a AND tags:b'));
  });

  it('IS NONE OF is NOT of the OR', () => {
    expect(parseAdvancedQuery('tags IS NONE OF (a, b)')).toEqual({
      kind: 'not',
      child: {
        kind: 'or',
        children: [
          { kind: 'term', field: 'tags', value: 'a' },
          { kind: 'term', field: 'tags', value: 'b' },
        ],
      },
    });
  });

  it('IS NOT ALL OF is NOT of the AND', () => {
    expect(parseAdvancedQuery('tags IS NOT ALL OF (a, b)')).toEqual({
      kind: 'not',
      child: {
        kind: 'and',
        children: [
          { kind: 'term', field: 'tags', value: 'a' },
          { kind: 'term', field: 'tags', value: 'b' },
        ],
      },
    });
  });

  it('CONTAINS ANY OF works on text, including phrases', () => {
    expect(parseAdvancedQuery('body CONTAINS ANY OF ("email data", "open file")')).toEqual({
      kind: 'or',
      children: [
        { kind: 'phrase', field: 'body', value: 'email data' },
        { kind: 'phrase', field: 'body', value: 'open file' },
      ],
    });
  });

  it('CONTAINS NONE OF and DOES NOT CONTAIN ANY OF mean the same thing', () => {
    const a = parseAdvancedQuery('body CONTAINS NONE OF (draft, wip)');
    const b = parseAdvancedQuery('body DOES NOT CONTAIN ANY OF (draft, wip)');
    expect(a).toEqual(b);
    expect(a).toEqual({
      kind: 'not',
      child: {
        kind: 'or',
        children: [
          { kind: 'term', field: 'body', value: 'draft' },
          { kind: 'term', field: 'body', value: 'wip' },
        ],
      },
    });
  });

  it('a single value in a list does not create a pointless group', () => {
    expect(parseAdvancedQuery('tags IS ANY OF (only)')).toEqual(parseQuery('tags:only'));
  });

  it('rejects an empty value list', () => {
    expect(() => parseAdvancedQuery('tags IS ANY OF ()')).toThrow(QuerySyntaxError);
  });
});

describe('parseAdvancedQuery — parameter names', () => {
  it("accepts the document's dotted email parameters", () => {
    expect(parseAdvancedQuery('from.address IS alice@example.com')).toEqual(
      parseQuery('from:alice@example.com'),
    );
    expect(parseAdvancedQuery('participant.address IS bob@example.com')).toEqual(
      parseQuery('participants:bob@example.com'),
    );
  });

  it("maps the document's names onto this app's fields", () => {
    // name.ext → extension, ingestion-date → acquired, sent-date → sent.
    expect(parseAdvancedQuery('name.ext IS pdf')).toEqual(parseQuery('extension:pdf'));
    expect(parseAdvancedQuery('ingestion-date > 2026-01-01')).toEqual(
      parseQuery('acquired>2026-01-01'),
    );
    expect(parseAdvancedQuery('sent-date < 2026-01-01')).toEqual(parseQuery('sent<2026-01-01'));
  });

  it('accepts this app’s own field names too, so nothing is lost', () => {
    expect(parseAdvancedQuery('threadid IS abc')).toEqual(parseQuery('threadid:abc'));
  });

  it('names a close match when a parameter does not exist here', () => {
    // The document lists parameters this app has no equivalent for; refusing
    // beats running a different search than the one that was typed.
    let message = '';
    try {
      parseAdvancedQuery('review-set IS batch1');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('review-set');
    // Either a near miss or the common-parameter list — never a bare refusal.
    expect(message).toMatch(/did you mean|supported parameters include/i);
    expect(message).toContain('tags');
  });

  it('suggests the nearest parameter for a typo', () => {
    let message = '';
    try {
      parseAdvancedQuery('subjct CONTAINS hello');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('subject');
  });

  it('lists the supported parameters for discovery', () => {
    expect(ADVANCED_PARAMETERS.length).toBeGreaterThan(40);
    expect(ADVANCED_PARAMETERS).toContain('body');
    expect(ADVANCED_PARAMETERS).toContain('from.address');
    // Parameters the app cannot answer must not be advertised.
    expect(ADVANCED_PARAMETERS).not.toContain('importedBates');
  });
});

describe('parseAdvancedQuery — operator/field compatibility', () => {
  it('CONTAINS on a keyword field says to use IS', () => {
    let message = '';
    try {
      parseAdvancedQuery('tags CONTAINS Documentation');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('IS');
  });

  it('IS on a text field says to use CONTAINS', () => {
    let message = '';
    try {
      parseAdvancedQuery('body IS insurance');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('CONTAINS');
  });

  it('CONTAINS on a date field points at the comparison operators', () => {
    let message = '';
    try {
      parseAdvancedQuery('date CONTAINS 2026');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/[<>]/);
  });

  it('EXISTS is allowed on any field type', () => {
    expect(parseAdvancedQuery('body EXISTS')).toEqual({ kind: 'exists', field: 'body' });
    expect(parseAdvancedQuery('date EXISTS')).toEqual({ kind: 'exists', field: 'date' });
  });
});

describe('parseAdvancedQuery — errors point at the problem', () => {
  it('reports the position of an unexpected symbol, like the document does', () => {
    // The document shows a caret under the offending column; that needs a position.
    try {
      parseAdvancedQuery('tags IS a AND');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QuerySyntaxError);
      // Points past "AND", where the missing condition belongs.
      if (err instanceof QuerySyntaxError) expect(err.position).toBe(13);
    }
  });

  it('points at the parameter when the parameter is the problem', () => {
    try {
      parseAdvancedQuery('body.date - 2026');
      throw new Error('should have thrown');
    } catch (err) {
      // body.date is in the document but has no equivalent here; the caret
      // belongs under the parameter, which is at column 0.
      if (err instanceof QuerySyntaxError) expect(err.position).toBe(0);
    }
  });

  it('says what it expected after a parameter', () => {
    let message = '';
    try {
      parseAdvancedQuery('body');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('CONTAINS');
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseAdvancedQuery('body CONTAINS "unclosed')).toThrow(QuerySyntaxError);
  });

  it('rejects unbalanced parentheses', () => {
    expect(() => parseAdvancedQuery('(tags IS a')).toThrow(QuerySyntaxError);
    expect(() => parseAdvancedQuery('tags IS a)')).toThrow(QuerySyntaxError);
  });

  it('rejects a value where an operator belongs', () => {
    expect(() => parseAdvancedQuery('CONTAINS body')).toThrow(QuerySyntaxError);
  });

  it('does not throw QueryValidationError for syntax problems', () => {
    // Callers distinguish the two: one is "you typed it wrong", the other is
    // "this query is too expensive or touches an unknown field".
    try {
      parseAdvancedQuery('body CONTAINS');
    } catch (err) {
      expect(err).not.toBeInstanceOf(QueryValidationError);
    }
  });
});
