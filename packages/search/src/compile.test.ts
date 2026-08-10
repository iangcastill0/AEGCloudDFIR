import { describe, expect, it } from 'vitest';
import {
  buildSearchRequest,
  compile,
  compileNode,
  wrapWithAuthorization,
  type AuthContext,
  type QueryDsl,
} from './compile.js';
import { QueryValidationError } from './errors.js';
import { DEFAULT_FIELD_REGISTRY } from './fields.js';
import { parseQuery } from './parser.js';
import { validateAst, type ValidatedAst } from './validate.js';

const AUTH: AuthContext = { tenantId: 'tenant-1', includePrivileged: false };

function validated(query: string): ValidatedAst {
  return validateAst(parseQuery(query), DEFAULT_FIELD_REGISTRY);
}

function compileString(query: string, auth: AuthContext = AUTH): QueryDsl {
  return compile(validated(query), auth);
}

/** Compile just the user part (no auth wrapper) for shape assertions. */
function inner(query: string): QueryDsl {
  return compileNode(validated(query).root);
}

interface WrappedBool {
  bool: { filter: QueryDsl[]; must: QueryDsl[] };
}

function asWrapped(query: QueryDsl): WrappedBool {
  expect(Object.keys(query)).toEqual(['bool']);
  const bool = query['bool'] as WrappedBool['bool'];
  expect(Array.isArray(bool.filter)).toBe(true);
  expect(Array.isArray(bool.must)).toBe(true);
  return { bool };
}

describe('tenant isolation (ADVERSARIAL)', () => {
  const giantOr = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' OR ');

  const matrix: [string, string][] = [
    ['empty query', ''],
    ['plain term', 'foo'],
    ['fielded OR', 'subject:"q" OR from:a@b.com'],
    ['negation', 'NOT foo'],
    ['double negation', 'NOT NOT foo'],
    ['header smuggling attempt', 'header.tenantId:other-tenant'],
    ['giant OR', giantOr],
    ['nested groups', '(a OR b) AND NOT (c OR d)'],
    ['case filter as user query', 'case:some-case'],
    ['range only', 'size>10mb'],
    ['exists only', 'from:*'],
  ];

  it.each(matrix)('%s: compiled query has the tenant filter at top level', (_name, query) => {
    const compiled = compileString(query);
    const { bool } = asWrapped(compiled);
    expect(bool.filter).toContainEqual({ term: { tenantId: 'tenant-1' } });
    expect(bool.filter[0]).toEqual({ term: { tenantId: 'tenant-1' } });
    expect(bool.must).toHaveLength(1);
  });

  it.each(matrix)('%s: compile output is exactly wrapWithAuthorization(compileNode(...))', (_name, query) => {
    const ast = validated(query);
    expect(compile(ast, AUTH)).toEqual(wrapWithAuthorization(compileNode(ast.root), AUTH));
  });

  it('rejects tenantId as a user-facing query field', () => {
    expect(() => validated('tenantId:other-tenant')).toThrow(QueryValidationError);
  });

  it('rejects caseIds and privileged document paths as user fields (only aliases exist)', () => {
    expect(() => validated('caseIds:x')).toThrow(QueryValidationError);
    // "privileged" IS queryable as an alias, but the wrapper filter still applies:
    const compiled = compileString('privileged:true');
    expect(asWrapped(compiled).bool.filter).toContainEqual({ term: { privileged: false } });
  });

  it('wraps the empty query (match_all) — no unfiltered path exists', () => {
    const compiled = compileString('');
    const { bool } = asWrapped(compiled);
    expect(bool.must).toEqual([{ match_all: {} }]);
    expect(bool.filter[0]).toEqual({ term: { tenantId: 'tenant-1' } });
  });

  it('applies the caseIds terms filter when provided', () => {
    const compiled = compileString('foo', { ...AUTH, caseIds: ['case-a', 'case-b'] });
    expect(asWrapped(compiled).bool.filter).toContainEqual({
      terms: { caseIds: ['case-a', 'case-b'] },
    });
  });

  it('an EMPTY caseIds array produces a terms filter that matches nothing', () => {
    const compiled = compileString('foo', { ...AUTH, caseIds: [] });
    expect(asWrapped(compiled).bool.filter).toContainEqual({ terms: { caseIds: [] } });
  });

  it('null caseIds means no case filter', () => {
    const compiled = compileString('foo', { ...AUTH, caseIds: null });
    const filters = asWrapped(compiled).bool.filter;
    expect(filters.some((f) => 'terms' in f)).toBe(false);
  });

  it('excludes privileged docs by default and only includes them when explicitly allowed', () => {
    expect(asWrapped(compileString('foo')).bool.filter).toContainEqual({
      term: { privileged: false },
    });
    const open = compileString('foo', { tenantId: 'tenant-1', includePrivileged: true });
    expect(
      asWrapped(open).bool.filter.some(
        (f) => JSON.stringify(f) === JSON.stringify({ term: { privileged: false } }),
      ),
    ).toBe(false);
  });

  it('refuses to wrap with an empty tenantId', () => {
    expect(() => wrapWithAuthorization({ match_all: {} }, { tenantId: '', includePrivileged: false })).toThrow(
      QueryValidationError,
    );
  });
});

describe('compile shapes', () => {
  it('AND → bool.must, OR → bool.should with minimum_should_match', () => {
    expect(inner('a AND b')).toEqual({
      bool: {
        must: [
          { multi_match: expect.objectContaining({ query: 'a' }) },
          { multi_match: expect.objectContaining({ query: 'b' }) },
        ],
      },
    });
    const or = inner('a OR b') as { bool: { should: unknown[]; minimum_should_match: number } };
    expect(or.bool.minimum_should_match).toBe(1);
    expect(or.bool.should).toHaveLength(2);
  });

  it('NOT → bool.must_not', () => {
    expect(inner('NOT tag:reviewed')).toEqual({
      bool: { must_not: [{ term: { tagNames: 'reviewed' } }] },
    });
  });

  it('unfielded terms search all text fields', () => {
    expect(inner('invoice')).toEqual({
      multi_match: {
        query: 'invoice',
        fields: [
          'text.body',
          'text.bodyHtml',
          'text.attachment',
          'text.file',
          'text.ocr',
          'name',
          'email.subject',
        ],
      },
    });
  });

  it('text field terms become match queries', () => {
    expect(inner('body:invoice')).toEqual({ match: { 'text.body': { query: 'invoice' } } });
  });

  it('fuzzy terms carry fuzziness', () => {
    expect(inner('body:receit~1')).toEqual({
      match: { 'text.body': { query: 'receit', fuzziness: 1 } },
    });
    expect(inner('receit~')).toEqual({
      multi_match: expect.objectContaining({ fuzziness: 2 }),
    });
    expect(inner('custodian:jsmith~1')).toEqual({
      fuzzy: { custodianEmail: { value: 'jsmith', fuzziness: 1 } },
    });
  });

  it('phrases become match_phrase with slop for proximity', () => {
    expect(inner('subject:"quarterly report"')).toEqual({
      match_phrase: { 'email.subject': { query: 'quarterly report', slop: 0 } },
    });
    expect(inner('body:"wire transfer"~5')).toEqual({
      match_phrase: { 'text.body': { query: 'wire transfer', slop: 5 } },
    });
    expect(inner('"wire transfer"~5')).toEqual({
      multi_match: expect.objectContaining({ type: 'phrase', slop: 5 }),
    });
  });

  it('address fields: full address → .address term, bare domain → .domain term', () => {
    expect(inner('bcc:bob@example.com')).toEqual({
      term: { 'email.bcc.address': 'bob@example.com' },
    });
    expect(inner('to:example.org')).toEqual({ term: { 'email.to.domain': 'example.org' } });
    expect(inner('from:Alice@Example.COM')).toEqual({
      term: { 'email.from.address': 'alice@example.com' },
    });
  });

  it('participants map to the normalized addresses object', () => {
    expect(inner('participants:alice@x.com')).toEqual({ term: { 'addresses.all': 'alice@x.com' } });
    expect(inner('participants:x.com')).toEqual({ term: { 'addresses.domains': 'x.com' } });
  });

  it('header fields become nested name+value queries', () => {
    expect(inner('header.X-Originating-IP:10.0.0.1')).toEqual({
      nested: {
        path: 'headers',
        query: {
          bool: {
            must: [
              { term: { 'headers.name': 'x-originating-ip' } },
              { match: { 'headers.value': { query: '10.0.0.1' } } },
            ],
          },
        },
      },
    });
  });

  it('header phrases use match_phrase inside the nested query', () => {
    const compiled = inner('header.received:"by mail.example.com"') as {
      nested: { query: { bool: { must: QueryDsl[] } } };
    };
    expect(compiled.nested.query.bool.must[1]).toEqual({
      match_phrase: { 'headers.value': { query: 'by mail.example.com', slop: 0 } },
    });
  });

  it('ocr queries search both the flat ocr text and nested pages', () => {
    expect(inner('ocr:"account number"')).toEqual({
      bool: {
        should: [
          { match_phrase: { 'text.ocr': { query: 'account number', slop: 0 } } },
          {
            nested: {
              path: 'ocrPages',
              query: { match_phrase: { 'ocrPages.text': { query: 'account number', slop: 0 } } },
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
    expect(inner('ocr:invoice')).toMatchObject({
      bool: { should: [{ match: { 'text.ocr': { query: 'invoice' } } }, { nested: {} }] },
    });
  });

  it('date ranges are inclusive with [ ... TO ... ]', () => {
    expect(inner('received:[2024-01-01 TO 2024-06-30]')).toEqual({
      range: { 'dates.received': { gte: '2024-01-01', lte: '2024-06-30' } },
    });
    expect(inner('sent>=2024-01-01')).toEqual({
      range: { 'dates.sent': { gte: '2024-01-01' } },
    });
    expect(inner('date:2024-03-05')).toEqual({
      range: { 'dates.primary': { gte: '2024-03-05', lte: '2024-03-05' } },
    });
  });

  it('size ranges convert units to bytes', () => {
    expect(inner('size>10mb')).toEqual({ range: { size: { gt: 10485760 } } });
    expect(inner('size:[1kb TO 5mb]')).toEqual({
      range: { size: { gte: 1024, lte: 5242880 } },
    });
    expect(inner('size:4096')).toEqual({ term: { size: 4096 } });
  });

  it('tag/case/produced map to denormalized fields', () => {
    expect(inner('tag:hot-docs')).toEqual({ term: { tagNames: 'hot-docs' } });
    expect(inner('case:case-1')).toEqual({ term: { caseIds: 'case-1' } });
    expect(inner('produced:true')).toEqual({ term: { hasBeenProduced: true } });
  });

  it('hash queries hit sha256 lowercased', () => {
    expect(inner('hash:DEADBEEF00')).toEqual({ term: { sha256: 'deadbeef00' } });
  });

  it('bates queries search begin and end numbers in the nested records', () => {
    expect(inner('bates:ABC0001')).toEqual({
      nested: {
        path: 'bates',
        query: {
          bool: {
            should: [
              { term: { 'bates.begBates': 'abc0001' } },
              { term: { 'bates.endBates': 'abc0001' } },
            ],
            minimum_should_match: 1,
          },
        },
      },
    });
  });

  it('wildcards run case-insensitively on keyword paths', () => {
    expect(inner('name:repor*')).toEqual({
      wildcard: { 'name.keyword': { value: 'repor*', case_insensitive: true } },
    });
    expect(inner('subject:quart*')).toEqual({
      wildcard: { 'email.subject.keyword': { value: 'quart*', case_insensitive: true } },
    });
    expect(inner('mime:application/vnd*')).toEqual({
      wildcard: { mimeType: { value: 'application/vnd*', case_insensitive: true } },
    });
  });

  it('exists queries resolve address and header fields sensibly', () => {
    expect(inner('from:*')).toEqual({ exists: { field: 'email.from.address' } });
    expect(inner('folder:*')).toEqual({ exists: { field: 'folder' } });
    expect(inner('header.x-mailer:*')).toEqual({
      nested: { path: 'headers', query: { term: { 'headers.name': 'x-mailer' } } },
    });
  });
});

describe('buildSearchRequest', () => {
  it('builds sane defaults with a score sort and id tiebreaker', () => {
    const req = buildSearchRequest(validated('foo'), AUTH);
    expect(req.size).toBe(50);
    expect(req.track_total_hits).toBe(true);
    expect(req.sort).toEqual([{ _score: { order: 'desc' } }, { evidenceItemId: { order: 'asc' } }]);
    expect(req.search_after).toBeUndefined();
    expect(req.highlight).toBeUndefined();
    expect(req.aggs).toBeUndefined();
    // The query is always the wrapped/authorized one:
    expect(req.query).toEqual(compile(validated('foo'), AUTH));
  });

  it('clamps limit to 100 and floors it at 1', () => {
    expect(buildSearchRequest(validated('foo'), AUTH, { limit: 1000 }).size).toBe(100);
    expect(buildSearchRequest(validated('foo'), AUTH, { limit: 0 }).size).toBe(1);
    expect(buildSearchRequest(validated('foo'), AUTH, { limit: 25 }).size).toBe(25);
  });

  it('maps sort fields with descending prefix and always appends the tiebreaker', () => {
    const req = buildSearchRequest(validated('foo'), AUTH, { sort: ['-primaryDate', 'name'] });
    expect(req.sort).toEqual([
      { 'dates.primary': { order: 'desc' } },
      { 'name.keyword': { order: 'asc' } },
      { evidenceItemId: { order: 'asc' } },
    ]);
  });

  it('rejects unknown sort fields', () => {
    expect(() => buildSearchRequest(validated('foo'), AUTH, { sort: ['tenantId'] })).toThrow(
      QueryValidationError,
    );
  });

  it('passes search_after through for pagination', () => {
    const cursor = ['2024-01-01T00:00:00Z', 'item-42'];
    const req = buildSearchRequest(validated('foo'), AUTH, {
      sort: ['-primaryDate'],
      searchAfter: cursor,
    });
    expect(req.search_after).toEqual(cursor);
  });

  it('adds highlight config with <mark> tags when requested', () => {
    const req = buildSearchRequest(validated('foo'), AUTH, { highlight: true });
    expect(req.highlight).toMatchObject({
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
    });
    expect(Object.keys((req.highlight as { fields: QueryDsl }).fields)).toContain('text.*');
    expect(Object.keys((req.highlight as { fields: QueryDsl }).fields)).toContain('email.subject');
  });

  it('builds terms aggregations of size 25 for requested facets', () => {
    const req = buildSearchRequest(validated('foo'), AUTH, {
      facets: ['custodianEmail', 'kind'],
    });
    expect(req.aggs).toEqual({
      custodianEmail: { terms: { field: 'custodianEmail', size: 25 } },
      kind: { terms: { field: 'kind', size: 25 } },
    });
  });

  it('rejects unknown facets (no arbitrary agg fields)', () => {
    expect(() => buildSearchRequest(validated('foo'), AUTH, { facets: ['tenantId'] })).toThrow(
      QueryValidationError,
    );
  });
});
